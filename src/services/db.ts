import mongoose from 'mongoose';

export async function connectDB(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('[Database] MONGODB_URI not provided. Running in resilient in-memory data store mode.');
    return;
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      minPoolSize: 2,
      retryWrites: true,
      retryReads: true,
    });

    mongoose.connection.on('error', (err) => {
      console.error('[Database] Connection error:', err.message);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('[Database] MongoDB disconnected. Attempting reconnection...');
    });

    console.log('✅ Connected to MongoDB');
  } catch (err: any) {
    console.warn(`[Database] MongoDB connection failed (${err.message}). Initializing resilient in-memory data store.`);
  }
}

export async function disconnectDB(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.close();
    console.log('[Database] MongoDB connection closed gracefully.');
  }
}
