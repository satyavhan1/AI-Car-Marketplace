-- DropForeignKey
ALTER TABLE "TestDriveBooking" DROP CONSTRAINT "TestDriveBooking_carId_fkey";

-- DropForeignKey
ALTER TABLE "TestDriveBooking" DROP CONSTRAINT "TestDriveBooking_userId_fkey";

-- AddForeignKey
ALTER TABLE "TestDriveBooking" ADD CONSTRAINT "TestDriveBooking_carId_fkey" FOREIGN KEY ("carId") REFERENCES "Car"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestDriveBooking" ADD CONSTRAINT "TestDriveBooking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
