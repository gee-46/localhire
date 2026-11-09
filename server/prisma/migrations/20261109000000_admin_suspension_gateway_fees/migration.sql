-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "gatewayFee" DECIMAL(10,2),
ADD COLUMN     "gatewayFeeTax" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedById" TEXT,
ADD COLUMN     "suspensionReason" TEXT;



-- Accounts that were deactivated before suspensions carried a reason keep isActive=false and have no recorded reason.
