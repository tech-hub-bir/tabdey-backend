import mongoose from "mongoose";
import { env } from "../config/env.js";

export async function connectMongo() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000
  });
  console.log("[mongo] connected");
}
