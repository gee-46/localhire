const express = require('express');
const { listCategories } = require('../controllers/workerController');

const router = express.Router();

// Public, read-only: the one list every category dropdown/filter is built from.
router.get('/', listCategories);

module.exports = router;
