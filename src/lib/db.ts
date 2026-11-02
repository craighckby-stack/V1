import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Errors and warnings only. 'query' was tried and rejected: it turned
    // dev.log into a firehose of SQL noise that buried real errors
    // (every poll cycle logs 5+ SELECTs, drowning the signal).
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db