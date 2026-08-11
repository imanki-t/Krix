import mongoose, { Document, Schema } from 'mongoose';
import { SecurityTier } from '../config/settings.js';

export interface IUser extends Document {
  email: string;
  passwordHash?: string;
  name: string;
  googleId?: string;
  avatarUrl?: string;
  securityTier: SecurityTier;
  isTotpEnabled: boolean;
  totpSecret?: string;
  encryptedGithubPat?: string;
  encryptedRenderKey?: string;
  knownIps: string[];
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String },
  name: { type: String, required: true },
  googleId: { type: String, sparse: true },
  avatarUrl: { type: String },
  securityTier: { type: String, enum: Object.values(SecurityTier), default: SecurityTier.STANDARD },
  isTotpEnabled: { type: Boolean, default: false },
  totpSecret: { type: String },
  encryptedGithubPat: { type: String },
  encryptedRenderKey: { type: String },
  knownIps: { type: [String], default: [] }
}, {
  timestamps: true
});

export const UserModel = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);

const memoryUsers = new Map<string, any>();

export const UserRepository = {
  async findByEmail(email: string): Promise<any> {
    if (mongoose.connection.readyState === 1) {
      return UserModel.findOne({ email: email.toLowerCase() });
    }
    for (const u of memoryUsers.values()) {
      if (u.email === email.toLowerCase()) return u;
    }
    return null;
  },

  async findById(id: string): Promise<any> {
    if (mongoose.connection.readyState === 1) {
      return UserModel.findById(id);
    }
    return memoryUsers.get(id) || null;
  },

  async findByGoogleId(googleId: string): Promise<any> {
    if (mongoose.connection.readyState === 1) {
      return UserModel.findOne({ googleId });
    }
    for (const u of memoryUsers.values()) {
      if (u.googleId === googleId) return u;
    }
    return null;
  },

  async create(userData: Partial<IUser>): Promise<any> {
    if (mongoose.connection.readyState === 1) {
      return UserModel.create(userData);
    }
    const id = new mongoose.Types.ObjectId().toString();
    const doc = { _id: id, id, ...userData, knownIps: userData.knownIps || [], createdAt: new Date(), updatedAt: new Date() };
    memoryUsers.set(id, doc);
    return doc;
  },

  async updateById(id: string, updates: Partial<IUser>): Promise<any> {
    if (mongoose.connection.readyState === 1) {
      return UserModel.findByIdAndUpdate(id, updates, { new: true });
    }
    const existing = memoryUsers.get(id);
    if (!existing) return null;
    Object.assign(existing, updates, { updatedAt: new Date() });
    return existing;
  }
};
