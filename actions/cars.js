"use server";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { serializeCarData } from "@/lib/helpers";
import fs from "fs";
import path from "path";
import { Prisma } from "@prisma/client";

// Function to convert File to base64
async function fileToBase64(file) {
  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);
  return buffer.toString("base64");
}

// Function to save image locally
async function saveImageLocally(base64Data, carId, index) {
  try {
    // Create cars directory if it doesn't exist
    const carsDir = path.join(process.cwd(), 'public', 'cars');
    if (!fs.existsSync(carsDir)) {
      fs.mkdirSync(carsDir, { recursive: true });
    }

    // Create car-specific directory
    const carDir = path.join(carsDir, carId);
    if (!fs.existsSync(carDir)) {
      fs.mkdirSync(carDir, { recursive: true });
    }

    // Extract image data
    const matches = base64Data.match(/^data:image\/([A-Za-z-+/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      throw new Error('Invalid base64 image data');
    }

    const extension = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const fileName = `image-${Date.now()}-${index}.${extension}`;
    const filePath = path.join(carDir, fileName);
    const imageBuffer = Buffer.from(matches[2], 'base64');

    // Save file
    fs.writeFileSync(filePath, imageBuffer);

    // Return public URL path
    return `/cars/${carId}/${fileName}`;

  } catch (error) {
    console.error('Error saving image locally:', error);
    throw new Error('Failed to save image: ' + error.message);
  }
}

// Gemini AI integration for car image processing
export async function processCarImageWithAI(file) {
  try {
    // Check if API key is available
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Gemini API key is not configured");
    }

    // Initialize Gemini API
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // Convert image file to base64
    const base64Image = await fileToBase64(file);

    // Create image part for the model
    const imagePart = {
      inlineData: {
        data: base64Image,
        mimeType: file.type,
      },
    };

    // Define the prompt for car detail extraction
    const prompt = `
      Analyze this car image and extract the following information:
      1. Make (manufacturer)
      2. Model
      3. Year (approximately)
      4. Color
      5. Body type (SUV, Sedan, Hatchback, etc.)
      6. Mileage
      7. Fuel type (your best guess)
      8. Transmission type (your best guess)
      9. Price (your best guess)
      9. Short Description as to be added to a car listing

      Format your response as a clean JSON object with these fields:
      {
        "make": "",
        "model": "",
        "year": 0000,
        "color": "",
        "price": "",
        "mileage": "",
        "bodyType": "",
        "fuelType": "",
        "transmission": "",
        "description": "",
        "confidence": 0.0
      }

      For confidence, provide a value between 0 and 1 representing how confident you are in your overall identification.
      Only respond with the JSON object, nothing else.
    `;

    // Get response from Gemini
    const result = await model.generateContent([imagePart, prompt]);
    const response = await result.response;
    const text = response.text();
    const cleanedText = text.replace(/```(?:json)?\n?/g, "").trim();

    // Parse the JSON response
    try {
      const carDetails = JSON.parse(cleanedText);

      // Validate the response format
      const requiredFields = [
        "make",
        "model",
        "year",
        "color",
        "bodyType",
        "price",
        "mileage",
        "fuelType",
        "transmission",
        "description",
        "confidence",
      ];

      const missingFields = requiredFields.filter(
        (field) => !(field in carDetails)
      );

      if (missingFields.length > 0) {
        throw new Error(
          `AI response missing required fields: ${missingFields.join(", ")}`
        );
      }

      // Return success response with data
      return {
        success: true,
        data: carDetails,
      };
    } catch (parseError) {
      console.error("Failed to parse AI response:", parseError);
      console.log("Raw response:", text);
      return {
        success: false,
        error: "Failed to parse AI response",
      };
    }
  } catch (error) {
    console.error("Gemini API error:", error);
    throw new Error("Gemini API error:" + error.message);
  }
}

// Add a car to the database with images
export async function addCar({ carData, images }) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) throw new Error("User not found");

    // Validate required fields
    if (!carData.price) {
      throw new Error("Price is required");
    }

    // Create a unique ID for this car
    const carId = uuidv4();
    const imageUrls = [];

    // Save all images locally
    for (let i = 0; i < images.length; i++) {
      try {
        const imageUrl = await saveImageLocally(images[i], carId, i);
        imageUrls.push(imageUrl);
      } catch (error) {
        console.warn(`Failed to save image ${i}:`, error.message);
        // Continue with other images even if one fails
      }
    }

    if (imageUrls.length === 0) {
      throw new Error("No valid images were uploaded");
    }

    // Convert price to Decimal for database
    const priceDecimal = new Prisma.Decimal(carData.price);

    // Add the car to the database
    const car = await db.car.create({
      data: {
        id: carId,
        make: carData.make,
        model: carData.model,
        year: carData.year,
        price: priceDecimal, // Use Decimal type
        mileage: carData.mileage,
        color: carData.color,
        fuelType: carData.fuelType,
        transmission: carData.transmission,
        bodyType: carData.bodyType,
        seats: carData.seats || 4, // Default to 4 seats if not provided
        description: carData.description,
        status: carData.status || "AVAILABLE", // Default to available
        featured: carData.featured || false, // Default to not featured
        images: imageUrls,
      },
    });

    // Revalidate the cars list page
    revalidatePath("/admin/cars");

    return {
      success: true,
    };
  } catch (error) {
    throw new Error("Error adding car:" + error.message);
  }
}

// Fetch all cars with simple search
export async function getCars(search = "") {
  try {
    // Build where conditions
    let where = {};

    // Add search filter
    if (search) {
      where.OR = [
        { make: { contains: search, mode: "insensitive" } },
        { model: { contains: search, mode: "insensitive" } },
        { color: { contains: search, mode: "insensitive" } },
      ];
    }

    // Execute main query
    const cars = await db.car.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    const serializedCars = cars.map(serializeCarData);

    return {
      success: true,
      data: serializedCars,
    };
  } catch (error) {
    console.error("Error fetching cars:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// Delete a car by ID
export async function deleteCar(id) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    // First, fetch the car to get its images
    const car = await db.car.findUnique({
      where: { id },
      select: { images: true },
    });

    if (!car) {
      return {
        success: false,
        error: "Car not found",
      };
    }

    // Delete the car from the database
    await db.car.delete({
      where: { id },
    });

    // Delete the images from local storage
    try {
      for (const imageUrl of car.images) {
        try {
          // Extract file path from URL
          const urlPath = imageUrl.replace(/^\//, '');
          const filePath = path.join(process.cwd(), 'public', urlPath);
          
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }

          // Try to remove the car directory if empty
          const carDir = path.dirname(filePath);
          if (fs.existsSync(carDir)) {
            const files = fs.readdirSync(carDir);
            if (files.length === 0) {
              fs.rmdirSync(carDir);
            }
          }
        } catch (fileError) {
          console.warn(`Could not delete image file ${imageUrl}:`, fileError.message);
        }
      }
    } catch (storageError) {
      console.error("Error with file operations:", storageError);
      // Continue with the function even if file operations fail
    }

    // Revalidate the cars list page
    revalidatePath("/admin/cars");

    return {
      success: true,
    };
  } catch (error) {
    console.error("Error deleting car:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// Update car status or featured status
export async function updateCarStatus(id, { status, featured }) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const updateData = {};

    if (status !== undefined) {
      updateData.status = status;
    }

    if (featured !== undefined) {
      updateData.featured = featured;
    }

    // Update the car
    await db.car.update({
      where: { id },
      data: updateData,
    });

    // Revalidate the cars list page
    revalidatePath("/admin/cars");

    return {
      success: true,
    };
  } catch (error) {
    console.error("Error updating car status:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}