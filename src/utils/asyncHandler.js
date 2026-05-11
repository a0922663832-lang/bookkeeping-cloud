// src/utils/asyncHandler.js
// Express 4 async error wrapper. 用法:
//   router.post('/x', asyncHandler(async (req, res) => { ... }))
// 拋出的錯誤會被 catch 並交給 Express error middleware.

'use strict';

module.exports = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
