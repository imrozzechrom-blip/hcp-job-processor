import { IHcpJob, ICompany } from "./types";
import { JobProcessorDeps } from "./deps";
export declare function handleJobs(job: IHcpJob, eventType: string | undefined, // Fixed: Was invalid "string | ,"
jobId: string, company: ICompany, deps: JobProcessorDeps): Promise<void>;
export declare function findExistingCombinedJob(HcpJob: any, jobId: string, companyId: string): Promise<any>;
export declare function findMostRecentLinkedCallJob(uniqueCallrailCustomers: any[], jobTimestamp: Date, companyId: string, deps: JobProcessorDeps): Promise<any>;
export declare function updateParentJobFromPrimary(jobRecord: any): void;
export declare function findPrimaryJobComponent(components: any[]): any;
