const { sendEmail } = require("../services/emailService");

/* =======================================================
   SEND EMAIL API
======================================================= */
async function sendEmailController(req, res) {
  try {
    const { to, subject, message } = req.body;

    if (!to || !subject || !message) {
      return res.status(400).json({
        ok: false,
        message: "Missing required fields",
      });
    }

    await sendEmail({
      to,
      subject,
      text: message,
      html: `
        <div style="font-family: Arial, sans-serif;">
          <h2>TàbDey Support</h2>
          <p>${message}</p>
          <br/>
          <small>NOte: Please feel free to ask anything! Good Day Ahead!</small>
        </div>
      `,
    });

    return res.json({
      ok: true,
      message: "Email sent successfully",
    });
  } catch (err) {
    console.error("Email Error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to send email",
    });
  }
}

module.exports = { sendEmailController };
