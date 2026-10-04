const Shop = require("../models/Shop");
const Address = require("../models/Address");
const User = require("../models/User");
const { getPlatformSettings } = require("../utils/settingsService");
const { distanceInKm } = require("../utils/distance");


// Helper: check if lat/lng is within platform radius (from settings)
async function checkWithinPlatform(lat, lng) {
  const settings = await getPlatformSettings();

  const distance = distanceInKm(
    settings.platform_center.lat,
    settings.platform_center.lng,
    lat,
    lng
  );

  const distanceKm = Number(distance.toFixed(2));
  const isWithin = distanceKm <= settings.platform_radius_km;

  return {
    isWithin,
    distanceKm,
    radiusLimitKm: settings.platform_radius_km,
    center: settings.platform_center
  };
}

// POST /api/shops  (shop registration request by logged-in user)
const registerShop = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      name,
      phone,
      description,
      line1,
      line2,
      city,
      state,
      pincode,
      lat,
      lng,
      service_radius_km,
      tags
    } = req.body;

    if (!name || !line1 || lat == null || lng == null) {
      return res
        .status(400)
        .json({ message: "name, line1, lat and lng are required" });
    }

    const { isWithin, distanceKm, radiusLimitKm, center } =
      await checkWithinPlatform(lat, lng);

    if (!isWithin) {
      return res.status(400).json({
        message:
          "Shop location is outside the platform's service area from center.",
        distance_from_center_km: distanceKm,
        max_radius_km: radiusLimitKm,
        center
      });
    }

    const existingShop = await Shop.findOne({ owner_user_id: userId });
    if (existingShop) {
      return res.status(400).json({
        message: "You already have a shop registered.",
        shop_id: existingShop._id
      });
    }

    const shop = await Shop.create({
      owner_user_id: userId,
      name,
      phone,
      description,
      address: {
        line1,
        line2,
        city,
        state,
        pincode,
        location: {
          type: "Point",
          coordinates: [lng, lat]
        }
      },
      service_radius_km: service_radius_km || 5,
      tags
    });

    if (req.user.role !== "SHOP_OWNER" && req.user.role !== "OWNER") {
      await User.findByIdAndUpdate(userId, { role: "SHOP_OWNER" });
    }

    res.status(201).json({
      success: true,
      shop,
      message:
        "Shop registration submitted. Waiting for approval from platform owner."
    });
  } catch (err) {
    console.error("registerShop error:", err);
    res.status(500).json({ message: "Server error" });
  }
};


// GET /api/shops/my  (shop owner dekh sakta hai apna shop)
const getMyShop = async (req, res) => {
  try {
    const userId = req.user.id;

    const shop = await Shop.findOne({ owner_user_id: userId });

    if (!shop) {
      return res.status(404).json({ message: "No shop found for this user." });
    }

    res.json({ success: true, shop });
  } catch (err) {
    console.error("getMyShop error:", err);
    res.status(500).json({ message: "Server error" });
  }
};


// GET /api/admin/shops  (OWNER/MANAGER) - list with filters
const adminListShops = async (req, res) => {
  try {
    const { status } = req.query; // PENDING / APPROVED / REJECTED
    const filter = {};

    if (status) {
      filter.status = status;
    }

    const shops = await Shop.find(filter)
      .populate("owner_user_id", "phone name role")
      .sort({ createdAt: -1 });

    res.json({ success: true, shops });
  } catch (err) {
    console.error("adminListShops error:", err);
    res.status(500).json({ message: "Server error" });
  }
};


// PATCH /api/admin/shops/:id/status  (approve/reject)
const adminUpdateShopStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejection_reason } = req.body; // status: "APPROVED" or "REJECTED"

    if (!["APPROVED", "REJECTED", "SUSPENDED"].includes(status)) {
      return res
        .status(400)
        .json({ message: "Status must be APPROVED, REJECTED, or SUSPENDED" });
    }

    const shop = await Shop.findById(id);

    if (!shop) {
      return res.status(404).json({ message: "Shop not found" });
    }

    shop.status = status;
    if (status === "REJECTED") {
      shop.rejection_reason = rejection_reason || "Not specified";
    } else {
      shop.rejection_reason = undefined;
    }
    if (status === "SUSPENDED") {
      shop.is_open = false;
    }

    await shop.save();

    // Keep the shop owner's account approval gate in sync with the shop's
    // status, same as the management-portal approval flow does. Without
    // this, a shop approved here still shows the owner as "PENDING" and
    // they stay locked out of their own dashboard (requireApproved gate).
    if (shop.owner_user_id) {
      if (status === "APPROVED") {
        await User.findByIdAndUpdate(shop.owner_user_id, {
          approvalStatus: "APPROVED",
          role: "SHOP_OWNER"
        });
      } else if (status === "REJECTED") {
        await User.findByIdAndUpdate(shop.owner_user_id, {
          approvalStatus: "REJECTED"
        });
      }
      // SUSPENDED intentionally leaves approvalStatus untouched: the owner
      // was already approved, the shop is just temporarily disabled.
    }

    res.json({ success: true, shop });
  } catch (err) {
    console.error("adminUpdateShopStatus error:", err);
    res.status(500).json({ message: "Server error" });
  }
};


// PATCH /api/admin/shops/:id/config  (commission, timing, open/close, radius, tags)
const adminUpdateShopConfig = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      commission_percent,
      is_open,
      open_time,
      close_time,
      service_radius_km,
      tags
    } = req.body;

    const shop = await Shop.findById(id);

    if (!shop) {
      return res.status(404).json({ message: "Shop not found" });
    }

    if (commission_percent != null) {
      shop.commission_percent = commission_percent;
    }
    if (is_open != null) {
      shop.is_open = is_open;
    }
    if (open_time) {
      shop.open_time = open_time;
    }
    if (close_time) {
      shop.close_time = close_time;
    }
    if (service_radius_km != null) {
      shop.service_radius_km = service_radius_km;
    }
    if (tags) {
      shop.tags = tags;
    }

    await shop.save();

    res.json({ success: true, shop });
  } catch (err) {
    console.error("adminUpdateShopConfig error:", err);
    res.status(500).json({ message: "Server error" });
  }
};


// Helper: get coordinates either from query or user's default address
async function getUserCoordinatesOrDefault(req) {
  let { lat, lng } = req.query;

  if (lat != null && lng != null) {
    lat = parseFloat(lat);
    lng = parseFloat(lng);
    if (isNaN(lat) || isNaN(lng)) {
      throw new Error("Invalid lat/lng values in query");
    }
    return { lat, lng, source: "query" };
  }

  // If no query, use default address if logged in, else use platform center
  if (!req.user || !req.user.id) {
    const { getPlatformSettings } = require("../utils/settingsService");
    const settings = await getPlatformSettings();
    return { lat: settings.platform_center.lat, lng: settings.platform_center.lng, source: "fallback_center" };
  }

  const userId = req.user.id;

  let defaultAddress = await Address.findOne({
    user_id: userId,
    is_default: true
  });

  if (!defaultAddress) {
    // अगर default नहीं है, तो latest address ले लो
    defaultAddress = await Address.findOne({ user_id: userId }).sort({
      createdAt: -1
    });
  }

  if (!defaultAddress) {
    const err = new Error("No address found for user");
    err.code = "NO_ADDRESS";
    throw err;
  }

  const [lngA, latA] = defaultAddress.location.coordinates;

  return { lat: latA, lng: lngA, source: "address", address: defaultAddress };
}


// GET /api/shops/nearby?lat=&lng=&limit=&maxDistanceKm=
const getNearbyShops = async (req, res) => {
  try {
    const userId = req.user?.id;

    // 1. User coordinates (query या address से) – तुम्हारा पुराना helper जैसा ही रहेगा
    const { lat, lng, source, address } = await getUserCoordinatesOrDefault(req);

    // 2. Settings से platform center & radius
    const settings = await getPlatformSettings();

    const distanceFromCenter = distanceInKm(
      settings.platform_center.lat,
      settings.platform_center.lng,
      lat,
      lng
    );

    if (distanceFromCenter > settings.platform_radius_km) {
      return res.status(400).json({
        message:
          "Your location is outside the platform's service radius from center.",
        distance_from_center_km: Number(distanceFromCenter.toFixed(2)),
        max_radius_km: settings.platform_radius_km,
        center: settings.platform_center
      });
    }

    const limit = parseInt(req.query.limit || "20", 10);
    const maxDistanceKm = parseFloat(req.query.maxDistanceKm || "10");
    const maxDistanceMeters = maxDistanceKm * 1000;

    let shops = [];
    const mongoose = require("mongoose");
    if (mongoose.connection.readyState === 1) {
      shops = await Shop.aggregate([
        {
          $geoNear: {
            near: {
              type: "Point",
              coordinates: [lng, lat]
            },
            distanceField: "distance_meters",
            spherical: true,
            maxDistance: maxDistanceMeters,
            query: {
              status: "APPROVED",
              is_open: true
            }
          }
        },
        {
          $addFields: {
            distance_km: {
              $divide: ["$distance_meters", 1000]
            }
          }
        },
        {
          $match: {
            $expr: {
              $lte: ["$distance_km", "$service_radius_km"]
            }
          }
        },
        {
          $sort: {
            distance_km: 1
          }
        },
        {
          $limit: limit
        },
        {
          $project: {
            name: 1,
            phone: 1,
            description: 1,
            address: 1,
            service_radius_km: 1,
            is_open: 1,
            open_time: 1,
            close_time: 1,
            commission_percent: 1,
            tags: 1,
            status: 1,
            distance_km: 1,
            createdAt: 1
          }
        }
      ]);
    } else {
      console.warn("MongoDB not connected. Returning mock shops.");
      shops = [
        {
          _id: "m1",
          name: "Mock Spicy Route",
          description: "A great place for spicy food (Mock Data)",
          address: { line1: "123 Main St", city: "Gajraula" },
          service_radius_km: 10,
          is_open: true,
          tags: ["North Indian", "Mughlai", "Biryani"],
          status: "APPROVED",
          distance_km: 2.5,
          image_url: "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&q=80",
          rating: 4.8,
          delivery_time: "25-30 min",
          delivery_fee: 40
        },
        {
          _id: "m2",
          name: "Mock Burger & Brews",
          description: "Best burgers in town (Mock Data)",
          address: { line1: "456 Market Road", city: "Gajraula" },
          service_radius_km: 5,
          is_open: true,
          tags: ["Fast Food", "American", "Beverages"],
          status: "APPROVED",
          distance_km: 1.2,
          image_url: "https://images.unsplash.com/photo-1586816001966-79b736744398?w=800&q=80",
          rating: 4.5,
          delivery_time: "15-20 min",
          delivery_fee: 0
        }
      ];
    }

    res.json({
      success: true,
      source,
      user_location: { lat, lng },
      distance_from_center_km: Number(distanceFromCenter.toFixed(2)),
      platform_center: settings.platform_center,
      platform_radius_km: settings.platform_radius_km,
      limit,
      maxDistanceKm,
      count: shops.length,
      shops
    });
  } catch (err) {
    console.error("getNearbyShops error:", err);

    if (err.code === "NO_ADDRESS") {
      return res.status(400).json({
        message:
          "No address found for user. Please add an address or pass lat/lng in query."
      });
    }

    res.status(500).json({ message: "Server error" });
  }
};


// GET /api/shops/:id/public
const getShopPublicDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const shop = await Shop.findById(id).select(
      "name description phone address service_radius_km is_open open_time close_time tags status createdAt"
    );

    if (!shop || shop.status !== "APPROVED") {
      return res.status(404).json({ message: "Shop not found or not approved" });
    }

    res.json({ success: true, shop });
  } catch (err) {
    console.error("getShopPublicDetails error:", err);
    res.status(500).json({ message: "Server error" });
  }
};


module.exports = {
  registerShop,
  getMyShop,
  adminListShops,
  adminUpdateShopStatus,
  adminUpdateShopConfig,
  getNearbyShops,
  getShopPublicDetails
};