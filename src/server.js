/**
 * Express app entry point.
 * Serves the two write-back flows (price update, Helipro PO -> Sales Order)
 * plus the static UI in /public.
 */
import 'dotenv/config';
import express from 'express';
import config from './config.js';
import priceRouter from './routes/price.js';
import salesOrderRouter from './routes/salesorder.js';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static('public'));

app.get('/api/health', (req, res) => res.json({ ok: true, company: config.monitor.companyNumber }));

app.get('/api/config', (req, res) =>
  res.json({
    companies: config.monitor.companies,
    defaultCompany: config.monitor.companyNumber,
    salesAccountId: config.monitor.salesAccountId || null,
  }),
);

app.use('/api/price', priceRouter);
app.use('/api/salesorder', salesOrderRouter);

app.listen(config.app.port, () => {
  console.log(`ERP Write-Back listening on http://localhost:${config.app.port}`);
});
