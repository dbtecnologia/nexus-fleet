export default function handler(_request, response) {
  const key = process.env.GOOGLE_MAPS_API_KEY || '';
  response.setHeader('Cache-Control', 'no-store');
  response.status(200).json({ enabled: Boolean(key), key });
}
