import { IHcpJob, ICompany } from "./types";
import { JobProcessorDeps } from "./deps";
export declare function handleJobs(job: IHcpJob, eventType: string | undefined, jobId: string, company: ICompany, deps: JobProcessorDeps): Promise<{
    status: string;
}>;
