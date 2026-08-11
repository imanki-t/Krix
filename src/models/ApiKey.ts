import mongoose, { Document, Schema } from 'mongoose';

export interface IApiKey extends Document {
  userId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  rateLimitPerMin: number;
  maxMemoryMB: number;
  totalRequests: number;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ApiKeySchema = new Schema<IApiKey>({
  userId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  keyPrefix: { type: String, required: true },
  keyHash: { type: String, required: true, unique: true, index: true },
  rateLimitPerMin: { type: Number, default: 60 },
  maxMemoryMB: { type: Number, default: 512 },
  totalRequests: { type: Number, default: 0 },
  lastUsedAt: { type: Date }
}, {
  timestamps: true
});

export const ApiKeyModel = mongoose.models.ApiKey || mongoose.model<IApiKey>('ApiKey', ApiKeySchema);

const memoryApiKeys = new Map<string, any>();

export const ApiKeyRepository = {
  async countByUser(userId: string): Promise<number> {
    if (mongoose.connection.readyState === 1) {
      return ApiKeyModel.countDocuments({ userId });
    }
    let count = 0;
    for (const k of memoryApiKeys.values()) {
      if (k.userId === userId) count++;
    }
    return count;
  },

  async listByUser(userId: string): Promise<any[]> {
    if (mongoose.connection.readyState === 1) {
      return ApiKeyModel.find({ userId }).sort({ createdAt: -1 });
    }
    return Array.from(memoryApiKeys.values()).filter(k => k.userId === userId);
  },

  async findByHash(keyHash: string): Promise<any> {
    if (mongoose.connection.readyState === 1) {
      return ApiKeyModel.findOne({ keyHash });
    }
    return memoryApiKeys.get(keyHash) || null;
  },

  async create(keyData: Partial<IApiKey>): Promise<any> {
    if (mongoose.connection.readyState === 1) {
      return ApiKeyModel.create(keyData);
    }
    const id = new mongoose.Types.ObjectId().toString();
    const doc = { _id: id, id, ...keyData, totalRequests: 0, createdAt: new Date(), updatedAt: new Date() };
    memoryApiKeys.set(keyData.keyHash!, doc);
    return doc;
  },

  async delete(userId: string, id: string): Promise<boolean> {
    if (mongoose.connection.readyState === 1) {
      const res = await ApiKeyModel.deleteOne({ _id: id, userId });
      return res.deletedCount > 0;
    }
    for (const [hash, k] of memoryApiKeys.entries()) {
      if (k.id === id && k.userId === userId) {
        memoryApiKeys.delete(hash);
        return true;
      }
    }
    return false;
  },

  async recordUsage(keyHash: string): Promise<void> {
    if (mongoose.connection.readyState === 1) {
      await ApiKeyModel.updateOne({ keyHash }, { $inc: { totalRequests: 1 }, lastUsedAt: new Date() });
      return;
    }
    const doc = memoryApiKeys.get(keyHash);
    if (doc) {
      doc.totalRequests = (doc.totalRequests || 0) + 1;
      doc.lastUsedAt = new Date();
    }
  }
};
