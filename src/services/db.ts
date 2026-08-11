import mongoose from 'mongoose';

export async function connectDB(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('[Database] MONGODB_URI not provided. Running in resilient in-memory data store mode.');
    return;
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000
    });
    console.log('✅ Connected to MongoDB');
  } catch (err: any) {
    console.warn(`[Database] MongoDB connection failed (${err.message}). Initializing resilient in-memory data store.`);
  }
}
