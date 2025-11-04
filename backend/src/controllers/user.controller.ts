import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { User } from '../models/User';

// Note: profile picture upload handling removed per product decision.

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
    // Profile picture updates are no longer accepted via this endpoint.
    
    // Update fullName if firstName or surname changed
    if (firstName || surname) {
      // fetch existing user to build fullName
      const existingUser = await User.findById(userId);
      if (existingUser) {
        updateData.fullName = `${firstName || existingUser.firstName} ${surname || existingUser.surname}`;
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

// Profile picture upload handler removed.

