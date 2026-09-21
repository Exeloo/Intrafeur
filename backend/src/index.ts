import express, { type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from './auth';
import factionsRouter from './routes/factions';
import assignmentsRouter from './routes/assignments';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Belt-and-suspenders CORS: the extension's background script talks to this
// API with host_permissions (not subject to CORS), but this keeps any other
// caller (e.g. a direct page-context fetch during debugging) from hitting a
// wall of unrelated CORS errors.
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/health', (req: Request, res: Response) => res.json({ status: 'ok' }));

app.use('/factions', requireAuth, factionsRouter);
app.use('/assignments', requireAuth, assignmentsRouter);

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`epitools-backend listening on port ${PORT}`);
});
