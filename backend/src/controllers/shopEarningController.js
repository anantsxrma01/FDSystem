const Shop = require("../models/Shop");
const ShopEarning = require("../models/ShopEarning");

const getMyShopEarnings = async (req, res) => {
  try {
    const userId = req.user.id;

    const shop = await Shop.findOne({ owner_user_id: userId });

    if (!shop) {
      return res.status(400).json({ message: "No shop found for this owner" });
    }

    const { from_date, to_date } = req.query;
    const filter = { shop_id: shop._id };

    if (from_date && to_date) {
      filter.createdAt = { $gte: new Date(from_date), $lte: new Date(to_date) };
    }

    const earnings = await ShopEarning.find(filter).sort({ createdAt: -1 });

    const totalNet = earnings.reduce((sum, e) => sum + e.net_payable, 0);

    res.json({
      success: true,
      shop_id: shop._id,
      totalNet,
      count: earnings.length,
      earnings
    });
  } catch (err) {
    console.error("getMyShopEarnings error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = { getMyShopEarnings };