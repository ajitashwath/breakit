import type { ChaosReport } from "./chaos/report";
import type { ChaosConfig, ExperimentResult } from "./chaos/types";

export interface RunRequest {
  url: string;
  config: Partial<ChaosConfig>;
  /** Pass the seed of a previous run to replay the exact same failures. */
  seed?: string;
}

export interface RunResponse {
  result: ExperimentResult;
  report: ChaosReport;
}

export interface RunError {
  error: string;
}
