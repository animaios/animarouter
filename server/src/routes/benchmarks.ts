import { Router } from 'express';
import type { Request, Response } from 'express';
import { BenchmarkService } from '../services/benchmarks.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const benchmarksRouter = Router();

// Sync benchmark scores for all models
benchmarksRouter.post('/sync', requireAuth, async (_req: Request, res: Response) => {
  const service = new BenchmarkService();
  const result = await service.updateAllBenchmarkScores();

  res.json({
    success: true,
    updated: result.updated,
    errors: result.errors,
    timestamp: new Date().toISOString()
  });
});

// Get all benchmark scores
benchmarksRouter.get('/scores', requireAuth, async (_req: Request, res: Response) => {
  const service = new BenchmarkService();
  const scores = await service.getBenchmarkScores();

  res.json({
    success: true,
    scores,
    timestamp: new Date().toISOString()
  });
});

// Get benchmark scores for specific platform
benchmarksRouter.get('/platform/:platform', requireAuth, async (req: Request, res: Response) => {
  const { platform } = req.params;
  const service = new BenchmarkService();
  const scores = await service.getScoresByPlatform(platform as string);

  res.json({
    success: true,
    platform,
    scores,
    timestamp: new Date().toISOString()
  });
});
