// models/platformFeeRuleModel.js
const { prisma } = require("../lib/prisma");

/**
 * Fetch active platform fee percentage rule.
 *
 * Old SQL:
 * SELECT fee_percent_bp
 * FROM platform_fee_rules
 * WHERE service_type = 'Platform Fee'
 * LIMIT 1
 *
 * Prisma version:
 * - service_type = Platform Fee
 * - is_active = true
 * - starts_at <= now
 * - ends_at is null OR ends_at >= now
 * - lowest priority first
 * - oldest rule_id fallback
 */
async function getFeePercentBp() {
  const now = new Date();

  const rule = await prisma.platform_fee_rules.findFirst({
    where: {
      service_type: "Platform Fee",
      is_active: true,
      starts_at: {
        lte: now,
      },
      OR: [
        {
          ends_at: null,
        },
        {
          ends_at: {
            gte: now,
          },
        },
      ],
    },
    select: {
      rule_id: true,
      fee_percent_bp: true,
      priority: true,
      service_type: true,
      is_active: true,
      starts_at: true,
      ends_at: true,
    },
    orderBy: [
      {
        priority: "asc",
      },
      {
        rule_id: "asc",
      },
    ],
  });

  if (!rule) return null;

  return {
    ...rule,
    rule_id: Number(rule.rule_id),
    fee_percent_bp: Number(rule.fee_percent_bp || 0),
  };
}

module.exports = {
  getFeePercentBp,
};