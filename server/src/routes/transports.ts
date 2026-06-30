import { Router } from "express";
import { listOutboundTransports } from "../services/outbound-transports.js";

export const transportsRouter = Router();

transportsRouter.get("/", (_req, res) => {
  res.json(listOutboundTransports());
});
