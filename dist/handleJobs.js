"use strict";
// src/handleJobs.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleJobs = handleJobs;
async function handleJobs(job, eventType, jobId, company, deps) {
    // Example: check if job exists
    const existingJob = await deps.HcpJob.findOne({ hcpId: jobId });
    if (existingJob) {
        await deps.HcpJob.updateOne({ hcpId: jobId }, { $set: { updatedAt: new Date() } });
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
