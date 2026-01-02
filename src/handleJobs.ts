// src/handleJobs.ts

import { IHcpJob, ICompany } from "./types";
import { JobProcessorDeps } from "./deps";

export async function handleJobs(
  job: IHcpJob,
  eventType: string | undefined,
  jobId: string,
  company: ICompany,
  deps: JobProcessorDeps
) {
  // Example: check if job exists
  const existingJob = await deps.HcpJob.findOne({ hcpId: jobId });

  if (existingJob) {
    await deps.HcpJob.updateOne(
      { hcpId: jobId },
      { $set: { updatedAt: new Date() } }
    );
    return { status: "updated" };
  }

  // Example: create new job
  const newJob = {
    hcpId: jobId,
    totalAmount: job.total_amount,
    companyId: company._id,
    createdAt: new Date()
  };

  await deps.HcpJob.save(newJob);

  return { status: "created" };
}
