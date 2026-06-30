import dotenv from "dotenv";
dotenv.config();

export const env = {
  PORT: process.env.PORT || 4000,
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",

  MYSQL_HOST: process.env.MYSQL_HOST || "127.0.0.1",
  MYSQL_PORT: Number(process.env.MYSQL_PORT || 3306),
  MYSQL_USER: process.env.MYSQL_USER || "root",
  MYSQL_PASSWORD: process.env.MYSQL_PASSWORD || "",
  MYSQL_DATABASE: process.env.MYSQL_DATABASE || "grablike",

  MONGO_URI: process.env.MONGO_URI || "mongodb://localhost:27017/grablike",
  CURRENCY: process.env.CURRENCY || "BTN"
};
