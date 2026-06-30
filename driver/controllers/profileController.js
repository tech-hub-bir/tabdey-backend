const { prisma } = require("../lib/prisma.js");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

// Helper function to convert BigInt to Number recursively
function serializeBigInt(data) {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "bigint") {
    return Number(data);
  }

  if (Array.isArray(data)) {
    return data.map((item) => serializeBigInt(item));
  }

  if (typeof data === "object") {
    const serialized = {};
    for (const key in data) {
      serialized[key] = serializeBigInt(data[key]);
    }
    return serialized;
  }

  return data;
}

// Helper function for consistent error responses
function errorResponse(res, statusCode, message) {
  return res.status(statusCode).json({ success: false, message });
}

// Helper function for success responses
function successResponse(res, statusCode, message, data = null) {
  const response = { success: true, message };
  if (data) response.data = data;
  return res.status(statusCode).json(response);
}

// GET profile
exports.getProfile = async (req, res) => {
  try {
    const userId = parseInt(req.params.user_id);

    if (!userId || isNaN(userId)) {
      return errorResponse(res, 400, "Invalid user information provided.");
    }

    const user = await prisma.users.findUnique({
      where: { user_id: userId },
      select: {
        user_id: true,
        user_name: true,
        email: true,
        phone: true,
        role: true,
        profile_image: true,
        is_verified: true,
        is_active: true,
        last_login: true,
        points: true,
      },
    });

    if (!user) {
      return errorResponse(
        res,
        404,
        "Account not found. Please check your information.",
      );
    }

    if (user.is_active === false) {
      return errorResponse(
        res,
        403,
        "Your account has been deactivated. Please contact support.",
      );
    }

    const serializedUser = serializeBigInt(user);

    return successResponse(
      res,
      200,
      "Profile retrieved successfully",
      serializedUser,
    );
  } catch (err) {
    console.error("Error fetching profile:", err.message);
    return errorResponse(
      res,
      500,
      "Unable to fetch profile at this time. Please try again later.",
    );
  }
};

// UPDATE profile
exports.updateProfile = async (req, res) => {
  try {
    const userId = parseInt(req.params.user_id);
    const { user_name, email, phone } = req.body;
    let newProfileImage = null;

    if (!userId || isNaN(userId)) {
      return errorResponse(res, 400, "Invalid user information provided.");
    }

    // Check if user exists
    const existingUser = await prisma.users.findUnique({
      where: { user_id: userId },
      select: { user_id: true, profile_image: true, email: true },
    });

    if (!existingUser) {
      return errorResponse(
        res,
        404,
        "Account not found. Please check your information.",
      );
    }

    // Handle new uploaded profile image
    if (req.file) {
      newProfileImage = `/uploads/profiles/${req.file.filename}`;

      if (existingUser.profile_image) {
        const oldImagePath = path.join(
          __dirname,
          "..",
          existingUser.profile_image,
        );
        fs.unlink(oldImagePath, (err) => {
          if (err && err.code !== "ENOENT") {
            console.error("Failed to delete old profile image:", err);
          }
        });
      }
    }

    // Check if email is already taken by another user
    if (email && email !== existingUser.email) {
      const emailExists = await prisma.users.findFirst({
        where: {
          email: email.toLowerCase(),
          user_id: { not: userId },
        },
      });

      if (emailExists) {
        return errorResponse(
          res,
          409,
          "This email is already registered to another account. Please use a different email.",
        );
      }
    }

    // Check if phone is already taken by another user
    if (phone) {
      const phoneExists = await prisma.users.findFirst({
        where: {
          phone: phone,
          user_id: { not: userId },
        },
      });

      if (phoneExists) {
        return errorResponse(
          res,
          409,
          "This phone number is already registered to another account. Please use a different number.",
        );
      }
    }

    // Build update data dynamically
    const updateData = {};

    if (user_name) {
      if (user_name.trim().length < 2) {
        return errorResponse(
          res,
          400,
          "Name must be at least 2 characters long.",
        );
      }
      updateData.user_name = user_name.trim();
    }

    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return errorResponse(res, 400, "Please provide a valid email address.");
      }
      updateData.email = email.toLowerCase().trim();
    }

    if (phone) {
      const phoneDigits = phone.replace(/\D/g, "");
      if (phoneDigits.length < 8 || phoneDigits.length > 12) {
        return errorResponse(res, 400, "Please provide a valid phone number.");
      }
      updateData.phone = phone.trim();
    }

    if (newProfileImage) {
      updateData.profile_image = newProfileImage;
    }

    if (Object.keys(updateData).length === 0) {
      return errorResponse(
        res,
        400,
        "No information provided to update. Please specify at least one field to change.",
      );
    }

    updateData.updated_at = new Date();

    await prisma.users.update({
      where: { user_id: userId },
      data: updateData,
    });

    let message = "Profile updated successfully";
    if (user_name) message = "Your name has been updated successfully";
    if (email) message = "Your email has been updated successfully";
    if (phone) message = "Your phone number has been updated successfully";
    if (newProfileImage)
      message = "Your profile picture has been updated successfully";
    if (Object.keys(updateData).length > 1)
      message = "Your profile has been updated successfully";

    return successResponse(res, 200, message);
  } catch (err) {
    console.error("Profile update error:", err);

    if (err.code === "P2025") {
      return errorResponse(
        res,
        404,
        "Account not found. Please check your information.",
      );
    }

    if (err.code === "P2002") {
      return errorResponse(
        res,
        409,
        "This information is already used by another account. Please use different values.",
      );
    }

    return errorResponse(
      res,
      500,
      "Unable to update profile at this time. Please try again later.",
    );
  }
};

// Change password
exports.changePassword = async (req, res) => {
  try {
    const userId = parseInt(req.params.user_id);
    const { current_password, new_password } = req.body || {};

    if (!userId || isNaN(userId)) {
      return errorResponse(res, 400, "Invalid user information provided.");
    }

    // Basic validations
    if (!current_password) {
      return errorResponse(res, 400, "Please provide your current password.");
    }

    if (!new_password) {
      return errorResponse(res, 400, "Please provide a new password.");
    }

    if (new_password.length < 8) {
      return errorResponse(
        res,
        400,
        "New password must be at least 8 characters long for security.",
      );
    }

    if (new_password.length > 100) {
      return errorResponse(
        res,
        400,
        "Password is too long. Please use a shorter password.",
      );
    }

    if (current_password === new_password) {
      return errorResponse(
        res,
        400,
        "New password must be different from your current password.",
      );
    }

    // Fetch user with password hash
    const user = await prisma.users.findUnique({
      where: { user_id: userId },
      select: {
        user_id: true,
        password_hash: true,
        is_active: true,
      },
    });

    if (!user) {
      return errorResponse(
        res,
        404,
        "Account not found. Please check your information.",
      );
    }

    if (user.is_active === false) {
      return errorResponse(
        res,
        403,
        "Your account has been deactivated. You cannot change password. Please contact support.",
      );
    }

    if (!user.password_hash) {
      return errorResponse(
        res,
        400,
        "Your account uses a different login method. Please contact support to set a password.",
      );
    }

    // Verify current password
    const isMatch = await bcrypt.compare(current_password, user.password_hash);
    if (!isMatch) {
      return errorResponse(
        res,
        401,
        "Current password is incorrect. Please try again.",
      );
    }

    // Hash new password
    const newHash = await bcrypt.hash(new_password, 10);

    // Update password
    await prisma.users.update({
      where: { user_id: userId },
      data: { password_hash: newHash },
    });

    return successResponse(
      res,
      200,
      "Your password has been changed successfully. Please use your new password for future logins.",
    );
  } catch (err) {
    console.error("Change password error:", err);

    if (err.code === "P2025") {
      return errorResponse(
        res,
        404,
        "Account not found. Please check your information.",
      );
    }

    return errorResponse(
      res,
      500,
      "Unable to change password at this time. Please try again later.",
    );
  }
};
