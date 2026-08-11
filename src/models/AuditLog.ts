import mongoose, { Document, Schema } from 'mongoose';

export interface IAuditLog extends Document {
  userId?: string;
  action: string;
  ipAddress: string;
  userAgent?: string;
  status: 'SUCCESS' | 'FAILURE' | 'BLOCKED';
  details?: Record<string, any>;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>({
  userId: { type: String, index: true },
  action: { type: String, required: true },
  ipAddress: { type: String, required: true },
  userAgent: { type: String },
  status: { type: String, enum: ['SUCCESS', 'FAILURE', 'BLOCKED'], default: 'SUCCESS' },
  details: { type: Schema.Types.Mixed }
}, {
  timestamps: { createdAt: true, updatedAt: false }
});

export const AuditLogModel = mongoose.models.AuditLog || mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);

const memoryAuditLogs: any[] = [];

export const AuditLogRepository = {
  async record(logData: Partial<IAuditLog>): Promise<void> {
    if (mongoose.connection.readyState === 1) {
      await AuditLogModel.create(logData).catch(() => {});
      return;
    }
    memoryAuditLogs.push({ ...logData, createdAt: new Date() });
    if (memoryAuditLogs.length > 500) memoryAuditLogs.shift();
  },

  async listByUser(userId: string, limit = 50): Promise<any[]> {
    if (mongoose.connection.readyState === 1) {
      return AuditLogModel.find({ userId }).sort({ createdAt: -1 }).limit(limit);
    }
    return memoryAuditLogs
      .filter(l => l.userId === userId)
      .slice(-limit)
      .reverse();
  }
};
