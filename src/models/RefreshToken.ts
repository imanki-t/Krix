import mongoose, { Document, Schema } from 'mongoose';

export interface IRefreshToken extends Document {
  tokenHash: string;
  userId: string;
  clientId?: string;
  familyId: string;
  scopes: string[];
  expiresAt: Date;
  revoked: boolean;
  replacedByTokenHash?: string;
  createdAt: Date;
  updatedAt: Date;
}

const RefreshTokenSchema = new Schema<IRefreshToken>({
  tokenHash: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  clientId: { type: String },
  familyId: { type: String, required: true, index: true },
  scopes: { type: [String], default: [] },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  revoked: { type: Boolean, default: false, index: true },
  replacedByTokenHash: { type: String }
}, {
  timestamps: true
});

export const RefreshTokenModel = mongoose.models.RefreshToken || mongoose.model<IRefreshToken>('RefreshToken', RefreshTokenSchema);

const memoryRefreshTokens = new Map<string, any>();

export const RefreshTokenRepository = {
  async create(data: Partial<IRefreshToken>): Promise<any> {
    if (mongoose.connection.readyState === 1) {
      return RefreshTokenModel.create(data);
    }
    const id = new mongoose.Types.ObjectId().toString();
    const doc = {
      _id: id,
      id,
      revoked: false,
      scopes: [],
      ...data,
      tokenHash: data.tokenHash || id,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    memoryRefreshTokens.set(doc.tokenHash, doc);
    return doc;
  },

  async findByHash(tokenHash: string): Promise<any> {
    if (mongoose.connection.readyState === 1) {
      return RefreshTokenModel.findOne({ tokenHash });
    }
    return memoryRefreshTokens.get(tokenHash) || null;
  },

  async revokeByHash(tokenHash: string, replacedByHash?: string): Promise<any> {
    if (mongoose.connection.readyState === 1) {
      return RefreshTokenModel.findOneAndUpdate(
        { tokenHash },
        { revoked: true, replacedByTokenHash: replacedByHash },
        { new: true }
      );
    }
    const doc = memoryRefreshTokens.get(tokenHash);
    if (doc) {
      doc.revoked = true;
      if (replacedByHash) doc.replacedByTokenHash = replacedByHash;
      doc.updatedAt = new Date();
    }
    return doc || null;
  },

  async revokeFamily(familyId: string): Promise<void> {
    if (mongoose.connection.readyState === 1) {
      await RefreshTokenModel.updateMany({ familyId }, { revoked: true });
      return;
    }
    for (const doc of memoryRefreshTokens.values()) {
      if (doc.familyId === familyId) {
        doc.revoked = true;
        doc.updatedAt = new Date();
      }
    }
  },

  async revokeAllForUser(userId: string): Promise<void> {
    if (mongoose.connection.readyState === 1) {
      await RefreshTokenModel.updateMany({ userId }, { revoked: true });
      return;
    }
    for (const doc of memoryRefreshTokens.values()) {
      if (doc.userId === userId) {
        doc.revoked = true;
        doc.updatedAt = new Date();
      }
    }
  }
};
