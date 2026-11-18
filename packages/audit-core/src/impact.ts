import { z } from "zod";
import { EvidenceSchema, RepoPathSchema } from "./finding";

export const ImpactContextSchema = z.strictObject({
  changedFiles: z.array(RepoPathSchema).max(5000),
  directDependencies: z
    .array(z.strictObject({ file: RepoPathSchema, dependsOn: z.array(RepoPathSchema).max(5000) }))
    .max(5000),
  // Files that import a changed file (one hop, both directions are reported separately).
  affectedFiles: z.array(RepoPathSchema).max(5000),
  complexity: z
    .array(z.strictObject({ file: RepoPathSchema, score: z.number().nonnegative() }))
    .max(5000),
  businessDomain: z.string().max(200).nullable(),
  evidence: z.array(EvidenceSchema).max(50),
});
export type ImpactContext = z.infer<typeof ImpactContextSchema>;

export function emptyImpact(): ImpactContext {
  return {
    changedFiles: [],
    directDependencies: [],
    affectedFiles: [],
    complexity: [],
    businessDomain: null,
    evidence: [],
  };
}
