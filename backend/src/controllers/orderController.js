// backend/src/controllers/orderController.js

const mongoose = require("mongoose");
const Order = require("../models/Order");
const Shop = require("../models/Shop");
const Item = require("../models/Item");
const Address = require("../models/Address");
const DeliveryPartner = require("../models/DeliveryPartner");
const User = require("../models/User");
const { distanceInKm } = require("../utils/distance");
const {
  generateOrderNumber,
  calculateDeliveryCharge
} = require("../utils/orderHelpers");
const {
  notifyOrderStatusChangedForUser,
  notifyOrderStatusChangedForShop,
  notifyOrderStatusChangedForDeliveryPartner
} = require("../services/notificationService");
const { sendOrderUpdate } = require("../utils/orderEventStream");
const { getPlatformSettings } = require("../utils/settingsService");
const fraudService = require("../services/fraudService"); 



// ---------------------- HELPER: AUTO ASSIGN RIDER ----------------------
// Helper: nearest online partner assign kare shop ke aas-paas
async function autoAssignDeliveryPartner(orderId) {
  const order = await Order.findById(orderId);

  if (!order) return null;
  if (order.delivery_partner_id) return null; // already assigned

  const shop = await Shop.findById(order.shop_id);

  if (!shop || !shop.address || !shop.address.location) return null;

  const [shopLng, shopLat] = shop.address.location.coordinates;

  // 5km radius me online partners dhundo
  const partner = await DeliveryPartner.findOne({
    status: "ACTIVE",
    is_online: true,
    current_location: {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: [shopLng, shopLat]
        },
        $maxDistance: 5000 // 5 km
      }
    }
  });

  if (!partner) return null;

  order.delivery_partner_id = partner._id;
  order.order_status = "ASSIGNED";
  order.timeline.assigned_at = new Date();

  await order.save();

  return partner;
}


// ---------------------- USER: PLACE ORDER ----------------------
const placeOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = req.user.id;
    const { shop_id, address_id, items, payment_mode } = req.body;

    const user = await User.findById(userId).session(session);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (payment_mode === "COD" && user.cod_blocked) {
      return res.status(400).json({
        message:
          "Cash on Delivery is temporarily disabled on your account due to repeated cancellations. Please use online payment."
      });
    }

    if (!shop_id || !address_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        message: "shop_id, address_id and non-empty items array are required"
      });
    }

    // Shop
    const shop = await Shop.findById(shop_id).session(session);
    if (!shop || shop.status !== "APPROVED" || !shop.is_open) {
      return res.status(400).json({ message: "Shop not available for orders" });
    }

    // Address
    const address = await Address.findOne({ _id: address_id, user_id: userId }).session(
      session
    );
    if (!address) {
      return res.status(400).json({ message: "Address not found for user" });
    }
    if (!address.is_serviceable) {
      return res.status(400).json({ message: "Address is outside service area" });
    }

    // Items validate
    const itemIds = items.map((it) => it.item_id);
    const dbItems = await Item.find({
      _id: { $in: itemIds },
      shop_id,
      is_deleted: false,
      is_available: true,
      in_stock: true
    }).session(session);

    if (dbItems.length !== items.length) {
      return res.status(400).json({
        message: "Some items are not available or invalid"
      });
    }

    const dbItemMap = {};
    dbItems.forEach((it) => {
      dbItemMap[it._id.toString()] = it;
    });

    let subTotal = 0;
    const orderItems = items.map((it) => {
      const dbItem = dbItemMap[it.item_id];
      const qty = it.qty || 1;
      const totalPrice = dbItem.price * qty;
      subTotal += totalPrice;
      return {
        item_id: dbItem._id,
        name: dbItem.name,
        price: dbItem.price,
        qty,
        is_veg: dbItem.is_veg,
        total_price: totalPrice
      };
    });

    // Distance (shop <-> address)
    const [shopLng, shopLat] = shop.address.location.coordinates;
    const [addrLng, addrLat] = address.location.coordinates;

    const distance = distanceInKm(shopLat, shopLng, addrLat, addrLng);
    const distanceKm = Number(distance.toFixed(2));

    // Load settings once
    const settings = await getPlatformSettings();

    // service active check
    if (!settings.is_service_active) {
      return res.status(503).json({
        message: "Service is temporarily unavailable. Please try again later."
      });
    } 
    // Delivery charge from settings
    const deliveryCharge = calculateDeliveryCharge(distanceKm, settings);

    // Total amount
    const totalAmount = subTotal + deliveryCharge;

    const finalPaymentMode = payment_mode === "ONLINE" ? "ONLINE" : "COD";
    const paymentStatus = "PENDING";

    const orderNumber = generateOrderNumber();

    const created = await Order.create(
      [
        {
          order_number: orderNumber,
          user_id: userId,
          shop_id,
          address_id,
          items: orderItems,
          payment_mode: finalPaymentMode,
          payment_status: paymentStatus,
          order_status: "PLACED",
          sub_total: subTotal,
          delivery_charge: deliveryCharge,
          total_amount: totalAmount,
          distance_km: distanceKm,
          timeline: {
            placed_at: new Date()
          }
        }
      ],
      { session }
    );

    const order = created[0];

    await session.commitTransaction();
    session.endSession();

    // 🔔 SSE: user ke order-detail page par live update bhejo
    try {
      // यदि तुम्हें populated order chahiye, तो yahan pe populate kar sakte ho:
      // const populated = await Order.findById(order._id)
      //   .populate("shop_id", "name")
      //   .populate("address_id", "label line1 city state pincode");
      // sendOrderUpdate(populated);

      sendOrderUpdate(order);
    } catch (e) {
      console.error("sendOrderUpdate error:", e.message);
    }

    // Notifications (user + shop)
    try {
      await notifyOrderStatusChangedForUser({
        order,
        newStatus: "PLACED"
      });
    } catch (e) {
      console.error("notifyOrderStatusChangedForUser error:", e.message);
    }

    try {
      await notifyOrderStatusChangedForShop({
        order,
        newStatus: "PLACED"
      });
    } catch (e) {
      console.error("notifyOrderStatusChangedForShop error:", e.message);
    }

    res.status(201).json({
      success: true,
      order
    });
  } catch (err) {
    console.error("placeOrder error:", err);
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ message: "Server error" });
  }
};


// ---------------------- USER: MY ORDERS ----------------------
const getMyOrders = async (req, res) => {
  try {
    const userId = req.user.id;

    const orders = await Order.find({ user_id: userId })
      .sort({ createdAt: -1 })
      .populate("shop_id", "name")
      .populate("address_id", "label line1 city");

    res.json({ success: true, orders });
  } catch (err) {
    console.error("getMyOrders error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const getMyOrderDetail = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const order = await Order.findOne({ _id: id, user_id: userId })
      .populate("shop_id", "name")
      .populate("address_id");

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error("getMyOrderDetail error:", err);
    res.status(500).json({ message: "Server error" });
  }
};


// ---------------------- SHOP OWNER: ORDERS LIST ----------------------
const getShopOrders = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { status } = req.query;

    const filter = {};

    if (userRole === "SHOP_OWNER") {
      const shop = await Shop.findOne({ owner_user_id: userId });
      if (!shop) {
        return res.status(400).json({ message: "No shop found for owner" });
      }
      filter.shop_id = shop._id;
    }

    if (status) {
      filter.order_status = status;
    }

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .populate("user_id", "phone")
      .populate("address_id", "line1 city");

    res.json({ success: true, orders });
  } catch (err) {
    console.error("getShopOrders error:", err);
    res.status(500).json({ message: "Server error" });
  }
};


// ---------------------- SHOP OWNER: UPDATE STATUS ----------------------
// PATCH /api/shop-owner/orders/:id/status
const updateOrderStatusByShop = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { id } = req.params;
    const { new_status, cancellation_reason } = req.body;

    const allowedStatuses = ["CONFIRMED", "PREPARING", "READY_FOR_PICKUP", "CANCELLED"];
    if (!allowedStatuses.includes(new_status)) {
      return res.status(400).json({ message: "Invalid status for shop update" });
    }

    // Shop owner ka shop filter (OWNER sab shops access kar sakta hai)
    let shopFilter = {};
    if (userRole === "SHOP_OWNER") {
      const shop = await Shop.findOne({ owner_user_id: userId });
      if (!shop) {
        return res.status(400).json({ message: "No shop found for owner" });
      }
      shopFilter.shop_id = shop._id;
    }

    let order = await Order.findOne({ _id: id, ...shopFilter });

    if (!order) {
      return res.status(404).json({ message: "Order not found for this shop" });
    }

    if (order.order_status === "CANCELLED") {
      return res.status(400).json({ message: "Order already cancelled" });
    }

    const now = new Date();

    // timeline update
    switch (new_status) {
      case "CONFIRMED":
        order.timeline.confirmed_at = now;
        break;
      case "PREPARING":
        order.timeline.preparing_at = now;
        break;
      case "READY_FOR_PICKUP":
        order.timeline.ready_at = now;
        break;
      case "CANCELLED":
        order.timeline.cancelled_at = now;
        order.cancellation_reason =
          cancellation_reason || "Cancelled by shop";
        break;
    }

    order.order_status = new_status;

    await order.save();


    // 🧨 RULE S1 – Shop High Cancel Rate
    if (new_status === "CANCELLED") {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const stats = await Order.aggregate([
    {
      $match: {
        shop_id: order.shop_id,
        createdAt: { $gte: sevenDaysAgo }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        cancelled: {
          $sum: {
            $cond: [{ $eq: ["$order_status", "CANCELLED"] }, 1, 0]
          }
        }
      }
    }
  ]);

  if (stats.length) {
    const total = stats[0].total || 0;
    const cancelled = stats[0].cancelled || 0;
    const cancelRate = total ? cancelled / total : 0;

    // Threshold check
    if (total >= 20 && cancelRate > 0.25) {
      await fraudService.raiseFraudFlag({
        entity_type: "SHOP",
        entity_id: order.shop_id,
        order_id: order._id,
        type: "HIGH_CANCEL_RATE",
        severity: 4,
        risk_points: 20,
        message: `Shop cancel rate ${(cancelRate * 100).toFixed(
          1
        )}% in last 7 days (total=${total}, cancelled=${cancelled})`
      });
    }
  }
}

    /* 
     * 🧨 RULE U1 – User COD Abuse (बार-बार COD cancel)
     * - Trigger: jab shop order ko CANCELLED kare
     * - Condition: payment_mode = COD
     * - Logic: last 7 days me user ne kitne COD orders cancel kiye
     *          agar 3+ ho gaye to fraud flag raise karo
     */
    if (new_status === "CANCELLED" && order.payment_mode === "COD") {
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const codCancelledCount = await Order.countDocuments({
          user_id: order.user_id,
          payment_mode: "COD",
          order_status: "CANCELLED",
          "timeline.cancelled_at": { $gte: sevenDaysAgo }
        });

        if (codCancelledCount >= 3) {
          await fraudService.raiseFraudFlag({
            entity_type: "USER",
            entity_id: order.user_id,
            order_id: order._id,
            type: "COD_ABUSE",
            severity: 3,
            risk_points: 15,
            message: `User cancelled ${codCancelledCount} COD orders in last 7 days`
          });
        }
      } catch (fraudErr) {
        // Fraud system fail hua to bhi main flow ko break मत करो
        console.error("COD abuse fraud check error:", fraudErr);
      }
    }
    // 🧨 U1 rule block ends here

    let assignedPartner = null;

    // READY_FOR_PICKUP par auto-assign try karo
    if (new_status === "READY_FOR_PICKUP") {
      assignedPartner = await autoAssignDeliveryPartner(order._id);
      // latest order (ASSIGNED ho chuka ho sakta hai)
      order = await Order.findById(order._id);
    }

    // 🔴 IMPORTANT: yahi line SSE clients ko live update bhejegi
    sendOrderUpdate(order);

    return res.json({
      success: true,
      order,
      assigned_partner: assignedPartner
    });
  } catch (err) {
    console.error("updateOrderStatusByShop error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};


module.exports = {
  placeOrder,
  getMyOrders,
  getMyOrderDetail,
  getShopOrders,
  updateOrderStatusByShop
};
