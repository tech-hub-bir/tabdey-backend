const path = require("path");
const fs = require("fs");
const winston = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");

const serviceName = process.env.SERVICE_NAME || "app";
const podName = process.env.POD_NAME || process.env.HOSTNAME || "local";

const baseLogDir = process.env.LOG_DIR || path.join(__dirname, "../logs");

const logDir = path.join(baseLogDir, serviceName, podName);
const auditDir = path.join(logDir, ".audit");

fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(auditDir, { recursive: true });

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

/**
 * IMPORTANT:
 * Set this to false to stop Winston logs from appearing in kubectl logs / console.
 * Logs will still be written to access and error log files.
 */
const LOG_TO_CONSOLE = false;

const transports = [];

if (LOG_TO_CONSOLE) {
  transports.push(new winston.transports.Console());
}

transports.push(
  new DailyRotateFile({
    filename: path.join(logDir, "access-%DATE%.log"),
    datePattern: "YYYY-MM-DD",
    maxSize: "20m",
    maxFiles: "14d",
    level: "info",
    auditFile: path.join(auditDir, "access-audit.json"),
  })
);

transports.push(
  new DailyRotateFile({
    filename: path.join(logDir, "error-%DATE%.log"),
    datePattern: "YYYY-MM-DD",
    maxSize: "20m",
    maxFiles: "30d",
    level: "error",
    auditFile: path.join(auditDir, "error-audit.json"),
  })
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: logFormat,
  transports,
  exitOnError: false,
});

module.exports = logger;