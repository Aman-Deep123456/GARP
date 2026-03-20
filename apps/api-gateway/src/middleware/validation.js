/**
 * Joi schema validation middleware.
 */
const Joi = require('joi');

/**
 * Telemetry payload schema — matches Listing 1 from the spec.
 */
const telemetrySchema = Joi.object({
  worker_id: Joi.string().required(),
  timestamp: Joi.string().isoDate().required(),
  location: Joi.object({
    latitude: Joi.number().min(-90).max(90).required(),
    longitude: Joi.number().min(-180).max(180).required(),
    accuracy: Joi.number().min(0).optional(),
    altitude: Joi.number().optional(),
    speed: Joi.number().min(0).optional(),
    bearing: Joi.number().min(0).max(360).optional(),
  }).required(),
  activity: Joi.object({
    type: Joi.string().valid('CYCLING', 'IN_VEHICLE', 'ON_FOOT', 'STILL', 'UNKNOWN').required(),
    confidence: Joi.number().min(0).max(100).required(),
  }).required(),
  accelerometer: Joi.object({
    x: Joi.number().required(),
    y: Joi.number().required(),
    z: Joi.number().required(),
    samples: Joi.array().items(
      Joi.object({
        x: Joi.number().required(),
        y: Joi.number().required(),
        z: Joi.number().required(),
        t: Joi.number().required(),
      })
    ).optional(),
  }).optional(),
  network: Joi.object({
    cell_id: Joi.string().optional(),
    signal_strength: Joi.number().optional(),
    network_type: Joi.string().optional(),
  }).optional(),
  gnss: Joi.object({
    agc: Joi.number().optional(),
    cn0: Joi.number().optional(),
  }).optional(),
  device: Joi.object({
    platform: Joi.string().optional(),
    integrity_token: Joi.string().optional(),
  }).optional(),
  s2_cell_id: Joi.string().optional(),
  ward_id: Joi.string().optional(),
});

/**
 * Generic validation middleware factory.
 */
function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], { abortEarly: false, stripUnknown: true });
    if (error) {
      const details = error.details.map((d) => d.message);
      return res.status(400).json({ error: 'Validation failed', details });
    }
    req[property] = value;
    next();
  };
}

module.exports = { telemetrySchema, validate };
