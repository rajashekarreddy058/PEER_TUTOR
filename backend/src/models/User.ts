import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  email: string;
  passwordHash: string;
  firstName: string;
  surname: string;
  fullName: string;
  isTutor: boolean;
  profilePicture?: string;
  bio?: string;
  grade?: string;
  subjects?: string[];
  educationalInstitute?: string;
  joinDate: Date;
}

const UserSchema = new Schema<IUser>({
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  firstName: { type: String, required: true },
  surname: { type: String, required: true },
  fullName: { type: String, required: true },
  isTutor: { type: Boolean, default: false },
  profilePicture: { type: String },
  bio: { type: String },
  grade: { type: String },
  subjects: [{ type: String }],
  educationalInstitute: { type: String },
  joinDate: { type: Date, default: Date.now }
}, { timestamps: true });

export const User = mongoose.model<IUser>('User', UserSchema);


