import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { User } from '../models/User';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/profile-pictures';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `profile-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

export const uploadProfilePictureMiddleware = upload.single('profilePicture');

export async function getUserProfile(req: Request, res: Response) {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select('-passwordHash');
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

export async function updateUserProfile(req: AuthRequest, res: Response) {
  try {
    const { userId } = req.params;
    const { firstName, surname, bio, grade, subjects, educationalInstitute } = req.body;
    
    // Verify the user is updating their own profile
    if (req.userId !== userId) {
      return res.status(403).json({ message: 'Unauthorized' });
    }
    
    const updateData: any = {};
    if (firstName) updateData.firstName = firstName;
    if (surname) updateData.surname = surname;
    if (bio !== undefined) updateData.bio = bio;
    if (grade !== undefined) updateData.grade = grade;
    if (subjects !== undefined) updateData.subjects = subjects;
    if (educationalInstitute !== undefined) updateData.educationalInstitute = educationalInstitute;
    
    // Update fullName if firstName or surname changed
    if (firstName || surname) {
      const user = await User.findById(userId);
      if (user) {
        updateData.fullName = `${firstName || user.firstName} ${surname || user.surname}`;
      }
    }
    
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true, select: '-passwordHash' }
    );
    
    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json(updatedUser);
  } catch (error) {
    console.error('Error updating user profile:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

export async function uploadProfilePicture(req: AuthRequest, res: Response) {
  try {
    const { userId } = req.params;
    
    // Verify the user is updating their own profile
    if (req.userId !== userId) {
      return res.status(403).json({ message: 'Unauthorized' });
    }
    
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    
    const profilePictureUrl = `/uploads/profile-pictures/${req.file.filename}`;
    
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { profilePicture: profilePictureUrl },
      { new: true, select: '-passwordHash' }
    );
    
    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json({ 
      message: 'Profile picture uploaded successfully',
      profilePicture: profilePictureUrl,
      user: updatedUser
    });
  } catch (error) {
    console.error('Error uploading profile picture:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

