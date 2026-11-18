import { z } from "zod";

export const EcosystemSchema = z.enum([
  "node",
  "python",
  "rust",
  "go",
  "java",
  "dotnet",
  "ruby",
  "php",
]);
export type Ecosystem = z.infer<typeof EcosystemSchema>;

export const PackageManagerSchema = z.enum(["pnpm", "npm", "yarn", "bun"]);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

export const DetectedProjectSchema = z.strictObject({
  path: z.string().min(1),
  name: z.string().min(1),
  ecosystems: z.array(EcosystemSchema),
  packageManager: PackageManagerSchema.nullable(),
  isMonorepo: z.boolean(),
  isGitRepo: z.boolean(),
});
export type DetectedProject = z.infer<typeof DetectedProjectSchema>;

export const ProjectSchema = DetectedProjectSchema.extend({
  id: z.string().min(1),
  addedAt: z.number().int().nonnegative(),
  lastOpenedAt: z.number().int().nonnegative(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectStatusSchema = ProjectSchema.extend({ pathExists: z.boolean() });
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectOpenParamsSchema = z.strictObject({ path: z.string().min(1) });
export const ProjectListParamsSchema = z.strictObject({});
export const ProjectStatusParamsSchema = z.strictObject({ id: z.string().min(1) });
export const ProjectListResultSchema = z.strictObject({ projects: z.array(ProjectSchema) });
export type ProjectListResult = z.infer<typeof ProjectListResultSchema>;
