// services/emailService.js
const nodemailer = require("nodemailer");
const PDFReceiptService = require("./pdfReceiptService");

class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });
  }

  async sendOrderReceipt(orderData) {
    try {
      console.log("📧 Preparing to send email...");

      // ✅ Ensure all required fields are passed to PDF service
      const pdfData = {
        // Required fields
        order_id: orderData.order_id,
        customer_name: orderData.customer_name,
        customer_email: orderData.customer_email,
        customer_phone: orderData.customer_phone || "N/A",
        business_name: orderData.business_name,
        business_logo: orderData.business_logo,
        business_address: orderData.business_address,
        payment_method: orderData.payment_method,
        status: orderData.status || "DELIVERED",
        items: orderData.items,
        subtotal: orderData.subtotal || 0,
        grand_total: orderData.grand_total || 0,
        delivery_address: orderData.delivery_address,
        delivered_at: orderData.delivered_at,

        // ✅ Important: Pass delivery_fee and platform_fee
        delivery_fee: orderData.delivery_fee || 0,
        platform_fee: orderData.platform_fee || 0,
        discount_amount: orderData.discount_amount || 0,
        merchant_delivery_fee: orderData.merchant_delivery_fee || 0,
      };

      console.log(`[EMAIL] Delivery Fee in PDF: ${pdfData.delivery_fee}`);
      console.log(`[EMAIL] Platform Fee in PDF: ${pdfData.platform_fee}`);

      const pdfBuffer = await PDFReceiptService.generateOrderReceipt(pdfData);

      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #4CAF50; color: white; padding: 20px; text-align: center; }
            .content { padding: 20px; background: #f9f9f9; }
            .order-details { background: white; padding: 15px; margin: 15px 0; border-radius: 5px; }
            .total { font-size: 18px; font-weight: bold; color: #4CAF50; }
            .footer { text-align: center; padding: 20px; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>ORDER DELIVERED</h2>
              <p>Order #: ${orderData.order_id}</p>
            </div>
            <div class="content">
              <p>Dear ${orderData.customer_name},</p>
              <p>Great news! Your order has been <strong>successfully delivered</strong>.</p>
              
              <div class="order-details">
                <h3>Order Summary</h3>
                <p><strong>Delivery Date:</strong> ${orderData.delivered_at ? new Date(orderData.delivered_at).toLocaleString() : "N/A"}</p>
                <p><strong>Business:</strong> ${orderData.business_name}</p>
                <p><strong>Payment Method:</strong> ${orderData.payment_method}</p>
                <p><strong>Total Amount:</strong> Nu. ${(orderData.grand_total || 0).toFixed(2)}</p>
              </div>
              
              <p>Please find attached your detailed receipt in PDF format.</p>
              <p>Thank you for choosing TàbDey!</p>
            </div>
            <div class="footer">
              <p>This is an automated message, please do not reply.</p>
              <p>&copy; ${new Date().getFullYear()} TàbDey. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `;

      const info = await this.transporter.sendMail({
        from: process.env.SMTP_FROM || `"TàbDey" <${process.env.SMTP_USER}>`,
        to: orderData.customer_email,
        subject: `Your Order Has Been Delivered - ${orderData.order_id}`,
        html: htmlContent,
        attachments: [
          {
            filename: `receipt-${orderData.order_id}.pdf`,
            content: pdfBuffer,
            contentType: "application/pdf",
          },
        ],
      });

      console.log(
        `[EMAIL] Receipt sent to ${orderData.customer_email}, Message ID: ${info.messageId}`,
      );
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error("[EMAIL ERROR]", error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new EmailService();
