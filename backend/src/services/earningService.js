const Shop = require("../models/Shop");
const ShopEarning = require("../models/ShopEarning");
const PartnerEarning = require("../models/PartnerEarning");
const { RIDER_SHARE_OF_DELIVERY, PLATFORM_SHARE_OF_DELIVERY } = require("../config/earningConfig");

// order: mongoose doc (populated नहीं भी हो तो चलेगा)
async function createEarningsForDeliveredOrder(order, partnerId) {
  // अगर पहले से earnings बन चुकी हों, skip
  if (order.shop_earning_created && order.partner_earning_created) return;

  const shop = await Shop.findById(order.shop_id);

  if (!shop) return;

  const commissionPercent = shop.commission_percent || 20;

  // SHOP earnings
  const shopGross = order.sub_total;
  const platformCommission = (shopGross * commissionPercent) / 100;
  const shopNet = shopGross - platformCommission;

  // DELIVERY earnings
  const deliveryTotal = order.delivery_charge;
  const partnerShare = deliveryTotal * RIDER_SHARE_OF_DELIVERY;
  const platformShareFromDelivery = deliveryTotal * PLATFORM_SHARE_OF_DELIVERY;

  // Order fields update (cached)
  order.shop_gross = shopGross;
  order.platform_commission = Number(platformCommission.toFixed(2));
  order.shop_net = Number(shopNet.toFixed(2));
  order.delivery_charge_partner = Number(partnerShare.toFixed(2));
  order.delivery_charge_platform = Number(platformShareFromDelivery.toFixed(2));

  const orderDate = order.delivered_at || new Date();

  // Shop earning record
  if (!order.shop_earning_created) {
    await ShopEarning.create({
      order_id: order._id,
      shop_id: order.shop_id,
      gross_amount: shopGross,
      commission_percent: commissionPercent,
      commission_amount: order.platform_commission,
      net_payable: order.shop_net
    });
    order.shop_earning_created = true;
  }

  // Partner earning record
  if (partnerId && !order.partner_earning_created) {
    await PartnerEarning.create({
      order_id: order._id,
      partner_id: partnerId,
      date: orderDate,
      delivery_charge_total: deliveryTotal,
      partner_share: order.delivery_charge_partner,
      platform_share_from_delivery: order.delivery_charge_platform
    });
    order.partner_earning_created = true;
  }

  await order.save();
}

module.exports = {
  createEarningsForDeliveredOrder
};