import { Router } from 'express';
import { getUserProfile, updateUserProfile, uploadProfilePicture, uploadProfilePictureMiddleware } from '../controllers/user.controller';
import { requireAuth } from '../middleware/auth.middleware';

export const router = Router();

router.get('/:userId', requireAuth, getUserProfile);
router.put('/:userId', requireAuth, updateUserProfile);
router.post('/:userId/profile-picture', requireAuth, uploadProfilePictureMiddleware, uploadProfilePicture);
