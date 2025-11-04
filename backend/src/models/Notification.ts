import mongoose, { Schema, Document, Types } from 'mongoose';

export interface INotification extends Document {
  userId: Types.ObjectId | string;
  type: 'session_booked' | 'session_cancelled' | 'session_completed' | 'session_started' | 'session_reminder' | 'feedback_received' | 'tutor_available' | 'system_announcement' | 'meeting_request' | 'session_updated' | 'session_rescheduled';
  title?: string;
  message?: string;
  data: Record<string, any>;
  read: boolean;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  category?: 'session' | 'feedback' | 'system' | 'reminder';
}

const NotificationSchema = new Schema<INotification>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { 
    type: String, 
    enum: ['session_booked', 'session_cancelled', 'session_completed', 'session_started', 'session_reminder', 'feedback_received', 'tutor_available', 'system_announcement', 'meeting_request', 'session_updated', 'session_rescheduled'], 
    required: true 
  },
  title: { type: String, required: false, default: '' },
  message: { type: String, required: false, default: '' },
  data: { type: Schema.Types.Mixed, default: {} },
  read: { type: Boolean, default: false },
  priority: { 
    type: String, 
    enum: ['low', 'medium', 'high', 'urgent'], 
    default: 'medium' 
  },
  category: { 
    type: String, 
    enum: ['session', 'feedback', 'system', 'reminder'], 
    required: false,
    default: 'session'
  },
}, { timestamps: true });

export const Notification = mongoose.model<INotification>('Notification', NotificationSchema);


