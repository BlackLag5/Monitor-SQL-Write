/**
 * Express app entry point.
 * Serves the two write-back flows (price update, Helipro PO -> Sales Order)
 * plus the static UI in /public.
 */
import 'dotenv/config';
import express from 'express';
import config from './config.js';
import { initAuth, registerAuthRoutes, loadUser, requireAuth } from './auth.js';
import priceRouter from './routes/price.js';
import salesOrderRouter from './routes/salesorder.js';

await initAuth();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

app.use(loadUser);
registerAuthRoutes(app);

// Pages: authenticated users get the app; everyone else lands on the login page.
app.get('/', (req, res) => res.redirect(req.user ? '/price.html' : '/login.html'));
app.get(['/price.html', '/salesorder.html'], (req, res, next) =>
  req.user ? next() : res.redirect('/login.html'),
);

app.use(express.static('public'));

app.get('/api/health', (req, res) => res.json({ ok: true, company: config.monitor.companyNumber }));

app.get('/api/config', requireAuth, (req, res) =>
  res.json({
    companies: config.monitor.companies,
    defaultCompany: config.monitor.companyNumber,
    salesAccountId: config.monitor.salesAccountId || null,
    user: req.user,
  }),
);

app.use('/api/price', requireAuth, priceRouter);
app.use('/api/salesorder', requireAuth, salesOrderRouter);

app.listen(config.app.port, () => {
  console.log(`ERP Workbench listening on http://localhost:${config.app.port}`);
});
