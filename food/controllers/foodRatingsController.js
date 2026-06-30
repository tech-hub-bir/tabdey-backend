const {
  insertFoodRating,
  fetchFoodRatings,
} = require("../models/foodRatingsModel");

async function createFoodRating(req, res) {
  try {
    const { business_id, user_id, rating, comment } = req.body || {};

    const result = await insertFoodRating({
      business_id,
      user_id,
      rating,
      comment,
    });

    return res.status(201).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    const status = error.statusCode || 400;
    return res.status(status).json({
      success: false,
      message: error.message || "Failed to save your rating. Please try again.",
    });
  }
}

async function getFoodRatings(req, res) {
  try {
    const { business_id } = req.params;
    const { page, limit } = req.query;

    const result = await fetchFoodRatings(business_id, { page, limit });

    return res.status(200).json({
      success: true,
      message: "Ratings fetched successfully.",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    const status = error.statusCode || 400;
    return res.status(status).json({
      success: false,
      message: error.message || "Failed to fetch ratings. Please try again.",
    });
  }
}

module.exports = { createFoodRating, getFoodRatings };
