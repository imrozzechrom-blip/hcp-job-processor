// src/handleJobs.ts

import { IHcpJob, ICompany, IHistoricalAverage } from "./types";
import { JobProcessorDeps } from "./deps";

export async function handleJobs(
  job: IHcpJob,
  eventType: string | undefined, // Fixed: Was invalid "string | ,"
  jobId: string,
  company: ICompany,
  deps: JobProcessorDeps
) {
  // Define companyId as a string early (consistent with original)
  const companyId = company._id.toString();

  // --- Handle Deletion Event (which has a minimal payload) edge case---
  if (eventType === "job.deleted") {
    console.log(`🗑️ Received deletion event for job ${jobId}. Treating as a cancellation.`);
    eventType = "job.canceled"; // Re-assign eventType to fall through to the cancellation logic

    // Fixed: Pass deps.HcpJob and use companyId (string)
    const existingHcpJob = await findExistingCombinedJob(deps.HcpJob, jobId, companyId);

    if (existingHcpJob) {
      const callCustomerId = existingHcpJob.toObject().callrailCustomerId;
      if (callCustomerId) {
        // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
        await deps.CallRailCustomer.findOneAndUpdate(
          {
            _id: callCustomerId,
            tags: {
              $nin: [
                "Booked Call",
                "PL - We will call back",
                "PL - Customer will call back",
                "Qualified but not booked",
                "Later Qualified",
              ],
            },
          },
          {
            $addToSet: { tags: "Later Qualified" },
          },
        );
      }
      // If the job is part of a combined record, update only its component
      if (existingHcpJob.jobComponents && existingHcpJob.jobComponents.length > 0) {
        const componentIndex = existingHcpJob.jobComponents.findIndex(
          (comp: any) => comp.hcpId === jobId,
        );

        if (componentIndex !== -1) {
          existingHcpJob.jobComponents[componentIndex].jobStatus = "canceled";
          existingHcpJob.jobComponents[componentIndex].updated_at = new Date();
          console.log(`✅ Marked component for job ${jobId} as 'canceled' in combined record.`);
        } else {
          console.warn(`⚠️ Job component ${jobId} not found in combined record for cancellation.`);
        }
        // Recalculate parent status and save
        updateParentJobFromPrimary(existingHcpJob);
        await existingHcpJob.save();
      } else {
        // This is a single job record, update its status directly
        existingHcpJob.jobStatus = "canceled";
        existingHcpJob.updated_at = new Date();
        await existingHcpJob.save();
        console.log(`✅ Marked job ${jobId} as 'canceled'.`);
      }
    } else {
      console.warn(
        `⚠️ Job ${jobId} not found in DB during 'job.deleted' event. Cannot mark as canceled.`,
      );
    }

    // Stop further processing as the deleted payload is incomplete
    return;
  }

  // Parse dates - check if they're already in UTC format
  let createdAt: Date;
  let updatedAt: Date;
  let completedAt: Date | null;
  // Try parsing as-is first (in case it's already UTC)
  createdAt = new Date(job.created_at);
  updatedAt = job.updated_at ? new Date(job.updated_at) : new Date(); // Fixed: Handle undefined updated_at

  completedAt = job?.completed_at ? new Date(job.completed_at) : null;

  // If parsing failed, try adding "Z" for UTC
  if (isNaN(createdAt.getTime())) {
    createdAt = new Date(job.created_at + "Z");
  }
  if (isNaN(updatedAt.getTime())) {
    updatedAt = new Date(job.updated_at + "Z");
  }

  if (completedAt && isNaN(completedAt.getTime())) {
    completedAt = new Date(job.completed_at + "Z");
  }

  // Validate dates to prevent "Invalid Date" errors
  if (isNaN(createdAt.getTime()) || isNaN(updatedAt.getTime())) {
    console.error("❌ Invalid date format received:", {
      created_at: job.created_at,
      updated_at: job.updated_at,
    });
    throw new Error("Invalid date format in job data");
  }

  const jobTimestamp = createdAt; // Always use created_at as the timestamp
  const address = job?.address;
  const zip = address?.zip;
  let mapData = null;

  // Only get geocoding data for NEW jobs, not for updates
  // Fixed: Use deps.HcpJob and companyId
  const existingHcpJob = await deps.HcpJob.findOne({
    hcpId: { $regex: jobId, $options: "i" },
    companyId: company._id,
  });

  if (!existingHcpJob && zip) {
    // Only get geocoding for new jobs with zip code
    mapData = await deps.getLatLonFromGeocode(address);
  } else if (existingHcpJob?.customer?.address?.mapData) {
    // Use existing map data for updates
    mapData = existingHcpJob.customer?.address.mapData;
  }

  // Fixed: Use deps.normalizePhone
  const phoneOptions = [
    deps.normalizePhone(job.customer?.mobile_number || ""),
    deps.normalizePhone(job.customer?.home_number || ""),
  ].filter(Boolean);

  console.log(`📞 Job ${jobId}: Phone options:`, phoneOptions);

  // Check if we have any phone numbers to search with
  if (phoneOptions.length === 0) {
    console.warn(`⚠️ No valid phone numbers found for job ${jobId}`);
  }

  const dateRange = new Date(jobTimestamp);
  dateRange.setDate(dateRange.getDate() - 31); // Changed from 30 to 31 days
  const extendedEndDate = new Date(jobTimestamp);
  extendedEndDate.setDate(extendedEndDate.getDate() + 31);

  // Validate dateRange to prevent MongoDB casting errors
  if (isNaN(dateRange.getTime()) || isNaN(extendedEndDate.getTime())) {
    console.error(
      "❌ Invalid dateRange or extendedEndDate calculated:",
      dateRange || extendedEndDate,
    );
    throw new Error("Invalid dateRange calculated");
  }

  // Collect ALL calls from both phone numbers
  const allCallrailCustomers = [];
  const phoneCallCounts: { [key: string]: number } = {};

  for (const phone of phoneOptions) {
    if (!phone) continue;

    console.log(
      `🔍 Searching for calls with phone ${phone} from ${dateRange.toISOString()} to ${jobTimestamp.toISOString()}`,
    );

    // Fixed: Use deps.CallRailCustomer and companyId
    const callsForPhone = await deps.CallRailCustomer.find({
      customer_phone_number: phone,
      created_at: { $gte: dateRange, $lt: extendedEndDate },
      companyId: company._id, // Add company filter
    });

    console.log(`📊 Found ${callsForPhone?.length || 0} calls for phone ${phone}`);

    if (callsForPhone?.length) {
      allCallrailCustomers.push(...callsForPhone);
      phoneCallCounts[phone] = callsForPhone.length;
    }
  }

  // Remove duplicates (in case the same call appears for both phone numbers)
  const uniqueCallrailCustomers = allCallrailCustomers.filter(
    (call, index, self) => index === self.findIndex(c => c._id.toString() === call._id.toString()),
  );

  console.log(
    `📋 Total unique calls found: ${uniqueCallrailCustomers.length} (from ${Object.keys(phoneCallCounts).length} phone numbers)`,
  );

  // Use enhanced call matching logic with special handling for estimate-linked calls
  // Fixed: Use deps.findBestCallrailCustomer and deps.normalizeDate
  const matchResult = await deps.findBestCallrailCustomer(
    uniqueCallrailCustomers,
    deps.normalizeDate(job.created_at),
    async (callrailId: string) => {
      const existingJob = await deps.HcpJob.findOne({
        callrailCustomerId: callrailId,
        companyId: company._id,
      });
      return !!existingJob;
    },
    "job",
    jobId,
  );

  let { call: callrailCustomer } = matchResult;
  const { matchReason, matchDetails: originalMatchDetails } = matchResult;
  let matchDetails = originalMatchDetails;
  // If it's a Mongoose document, convert it:
  if (callrailCustomer?.toObject) {
    callrailCustomer = callrailCustomer.toObject();
  }

  // Company ID for historical averages lookup
  const targetDate = new Date(job.created_at);

  targetDate.setUTCDate(targetDate.getUTCDate() - 1);
  targetDate.setUTCHours(0, 0, 0, 0);

  // Fixed: Use deps.HistoricalAverage
  let historicalDoc = (await deps.HistoricalAverage.findOne({
    companyId,
    date: targetDate,
  }).lean()) as IHistoricalAverage | null;

  if (!historicalDoc) {
    historicalDoc = (await deps.HistoricalAverage.findOne({ companyId })
      .sort({ date: -1 })
      .lean()) as IHistoricalAverage | null;
  }

  const historicalAverageRevenue = historicalDoc?.overallAverageRevenue || 0;
  const historicalSourceAverages = historicalDoc?.sourceAverages || {};
  const historicalSubSourceAverages = historicalDoc?.subSourceAverages || {};

  if (callrailCustomer) {
    // Create more detailed match information
    const callCreatedAt = new Date(callrailCustomer.created_at);
    const timeDiffHours =
      Math.abs(jobTimestamp.getTime() - callCreatedAt.getTime()) / (1000 * 60 * 60);
    const timeDiffDays = timeDiffHours / 24;

    // Check if this call has an estimate linked to it
    const linkedEstimate = await deps.HcpEstimate.findOne({
      callrailCustomerId: callrailCustomer._id,
      companyId: company._id, // Add companyId filter
    });
    const hasLinkedEstimate = !!linkedEstimate;

    const enhancedMatchDetails = {
      originalDetails: matchDetails,
      callId: callrailCustomer._id,
      callCreatedAt: callCreatedAt.toISOString(),
      jobCreatedAt: jobTimestamp.toISOString(),
      timeDifference: {
        hours: Math.round(timeDiffHours * 100) / 100,
        days: Math.round(timeDiffDays * 100) / 100,
      },
      callDuration: callrailCustomer.duration || "N/A",
      callTags: callrailCustomer.tags || [],
      customerPhone: callrailCustomer.customer_phone_number,
      matchedPhone:
        phoneOptions.find(phone => callrailCustomer.customer_phone_number === phone) || "Unknown",
      // Continuing from the previous snippet...

      searchWindow: {
        start: dateRange.toISOString(),
        end: jobTimestamp.toISOString(),
        totalCallsFound: uniqueCallrailCustomers.length,
      },
      matchQuality:
        timeDiffDays <= 1
          ? "Excellent"
          : timeDiffDays <= 7
            ? "Good"
            : timeDiffDays <= 31
              ? "Acceptable"
              : "Poor",
      matchConfidence:
        timeDiffDays <= 1
          ? "Very High"
          : timeDiffDays <= 3
            ? "High"
            : timeDiffDays <= 7
              ? "Medium"
              : "Low",
      estimateLinkage: {
        hasLinkedEstimate: hasLinkedEstimate,
        estimateId: linkedEstimate?.estimateId || null,
        estimateCreatedAt: linkedEstimate?.created_at || null,
        estimateJobRelationship: hasLinkedEstimate
          ? new Date(linkedEstimate.created_at) < jobTimestamp
            ? "Estimate created before job"
            : "Estimate created after job"
          : "No estimate linked",
      },
      businessContext: {
        jobCategory: job.job_fields.business_unit?.name || "Unknown",
        jobType: job.job_fields.job_type?.name || "Unknown",
        revenue: job.total_amount || 0,
        jobStatus: eventType || "Unknown",
      },
    };

    console.log(`✅ Job ${jobId} matched to call ${callrailCustomer._id}`);
    console.log(
      `   📊 Match Quality: ${enhancedMatchDetails.matchQuality} (${enhancedMatchDetails.matchConfidence} confidence)`,
    );
    console.log(
      `   ⏰ Time Difference: ${enhancedMatchDetails.timeDifference.days} days (${enhancedMatchDetails.timeDifference.hours} hours)`,
    );
    console.log(`   📞 Matched Phone: ${enhancedMatchDetails.matchedPhone}`);
    console.log(`   🏷️ Call Tags: ${enhancedMatchDetails.callTags.join(", ") || "None"}`);
    console.log(`   📞 Call Duration: ${enhancedMatchDetails.callDuration}`);
    console.log(`   💰 Job Revenue: $${enhancedMatchDetails.businessContext.revenue}`);
    console.log(`   🏢 Job Category: ${enhancedMatchDetails.businessContext.jobCategory}`);
    console.log(
      `   🔗 Estimate Linkage: ${enhancedMatchDetails.estimateLinkage.estimateJobRelationship}`,
    );
    console.log(`   🎯 Match Reason: ${matchReason}`);

    // Update matchDetails to use enhanced version
    matchDetails = JSON.stringify(enhancedMatchDetails);
  } else {
    const noMatchDetails = {
      reason: matchReason,
      jobId: jobId,
      jobCreatedAt: jobTimestamp.toISOString(),
      phoneNumbersSearched: phoneOptions,
      searchWindow: {
        start: dateRange.toISOString(),
        end: jobTimestamp.toISOString(),
        totalCallsFound: uniqueCallrailCustomers.length,
      },
      potentialIssues:
        uniqueCallrailCustomers.length === 0
          ? "No calls found in search window"
          : "All calls already linked to other jobs",
      recommendations:
        uniqueCallrailCustomers.length === 0
          ? "Check if customer phone numbers are correct or if calls exist outside search window"
          : "Consider expanding search criteria or checking for data inconsistencies",
      businessContext: {
        jobCategory: job.job_fields.business_unit?.name || "Unknown",
        jobType: job.job_fields.job_type?.name || "Unknown",
        revenue: job.total_amount || 0,
        jobStatus: eventType || "Unknown",
      },
    };

    console.log(`⚠️ No matching call found for job ${jobId}`);
    console.log(
      `   🔍 Search Window: ${noMatchDetails.searchWindow.start} to ${noMatchDetails.searchWindow.end}`,
    );
    console.log(`   📞 Phones Searched: ${noMatchDetails.phoneNumbersSearched.join(", ")}`);
    console.log(`   📊 Calls Found: ${noMatchDetails.searchWindow.totalCallsFound}`);
    console.log(`   💰 Job Revenue: $${noMatchDetails.businessContext.revenue}`);
    console.log(`   🏢 Job Category: ${noMatchDetails.businessContext.jobCategory}`);
    console.log(`   💡 Recommendation: ${noMatchDetails.recommendations}`);
    console.log(`   ❌ Reason: ${matchReason}`);

    // Update matchDetails to use enhanced version
    matchDetails = JSON.stringify(noMatchDetails);
  }
  const status = eventType?.replace("job.", "") || "created";
  const jobComponentData = {
    hcpId: jobId,
    revenue: job.total_amount,
    created_at: createdAt,
    updated_at: updatedAt,
    jobStatus: ["completed", "canceled"].includes(status) ? status : "created",
    customer: {
      id: job.customer?.id,
      firstName: job.customer?.first_name,
      lastName: job.customer?.last_name,
      email: job.customer?.email,
      mobileNumber: job.customer?.mobile_number,
      homeNumber: job.customer?.home_number,
      address: { ...address, mapData },
    },
    assigned_employees: job.assigned_employees,
    jobCategory: job.job_fields.business_unit?.name || "",
    jobType: job.job_fields.job_type?.name || "",
    schedule: job.schedule,
    completed_at: completedAt,
  };

  const jobDoc: any = {
    hcpId: jobId,
    revenue: job.total_amount,
    jobStatus: ["completed", "canceled"].includes(status) ? status : "created",
    customer: {
      id: job.customer?.id,
      firstName: job.customer?.first_name,
      lastName: job.customer?.last_name,
      email: job.customer?.email,
      mobileNumber: job.customer?.mobile_number,
      homeNumber: job.customer?.home_number,
      address: { ...address, mapData },
    },
    assigned_employees: job.assigned_employees,
    jobCategory: job.job_fields.business_unit?.name || "",
    jobType: job.job_fields.job_type?.name || "",
    schedule: job.schedule,
    completed_at: completedAt,
    created_at: createdAt,
    updated_at: updatedAt,
    companyId: company._id,
    matchReason: matchReason,
    matchDetails: matchDetails,
    jobComponents: [jobComponentData],
    average: {
      overallAverageRevenue: historicalAverageRevenue,
      sourceAverages: historicalSourceAverages,
      subSourceAverages: historicalSubSourceAverages,
      date: historicalDoc?.date,
    },
  };

  if (callrailCustomer?._id) {
    jobDoc.callrailCustomerId = callrailCustomer._id;
  }

  // Helper function to combine job with existing job record
  const combineWithExistingJob = async (jobData: any, existingJob: any) => {
    // Add this job as a component to the existing job
    const jobComponent = {
      hcpId: jobId,
      revenue: job.total_amount,
      jobStatus: ["completed", "canceled"].includes(status) ? status : "created",
      created_at: createdAt,
      updated_at: updatedAt,
      customer: jobData.customer,
      assigned_employees: jobData.assigned_employees,
      jobCategory: jobData.jobCategory,
      schedule: jobData.schedule,
      completed_at: jobData.completed_at,
      jobType: jobData.jobType,
    };

    // Initialize jobComponents array if it doesn't exist
    if (!existingJob.jobComponents) {
      existingJob.jobComponents = [];
    }

    // Check if this job component already exists
    const existingComponentIndex = existingJob.jobComponents.findIndex(
      (comp: any) => comp.hcpId === jobId,
    );

    if (existingComponentIndex >= 0) {
      // Update existing component
      existingJob.jobComponents[existingComponentIndex] = jobComponent;
    } else {
      // Add new component
      existingJob.jobComponents.push(jobComponent);
    }

    // Update combined revenue
    existingJob.revenue = existingJob.jobComponents.reduce(
      (total: number, comp: any) => total + (comp.revenue || 0),
      0,
    );

    // Update combined ID if needed
    if (!existingJob.hcpId.includes(jobId)) {
      existingJob.hcpId = `${existingJob.hcpId},${jobId}`;
    }

    // Update parent record from the primary component
    updateParentJobFromPrimary(existingJob);
    await existingJob.save();
    console.log(`🔄 Combined job ${jobId} with existing job ${existingJob.hcpId}`);
    return existingJob;
  };

  // Helper function to create a new job or combine with an existing one
  const createOrCombineJob = async (jobData: any, status: string) => {
    if (callrailCustomer) {
      // If a call is matched, create a new job record linked to it.
      if (historicalDoc) {
        jobData.average = {
          overallAverageRevenue: historicalAverageRevenue || 0,
          sourceAverages: historicalSourceAverages || {},
          subSourceAverages: historicalSubSourceAverages || {},
          date: historicalDoc?.date || targetDate,
        };
      }
      const newJob = deps.HcpJob.new({ ...jobData, jobStatus: status }); // Fixed: Use deps.HcpJob.new
      await newJob.save();
      console.log(
        `✅ Created new job ${jobId} with status '${status}' and linked to call ${callrailCustomer._id}`,
      );
    } else {
      // If no direct call match, try to find a related job to combine with.
      const mostRecentLinkedJob = await deps.findMostRecentLinkedCallJob(
        uniqueCallrailCustomers,
        jobTimestamp,
        companyId,
      );
      if (mostRecentLinkedJob) {
        // A related job was found, combine this new job with it.
        await combineWithExistingJob(jobData, mostRecentLinkedJob);
      } else {
        // Fallback: No related job found, create a standalone job record.
        if (historicalDoc) {
          jobData.average = {
            overallAverageRevenue: historicalAverageRevenue || 0,
            sourceAverages: historicalSourceAverages || {},
            subSourceAverages: historicalSubSourceAverages || {},
            date: historicalDoc?.date || targetDate,
          };
        }
        const newJob = deps.HcpJob.new({ ...jobData, jobStatus: status }); // Fixed: Use deps.HcpJob.new
        await newJob.save();
        console.log(
          `✅ Created new standalone job ${jobId} with status '${status}' (no call link).`,
        );
      }
    }
  };

  const jobStatus = jobDoc?.jobStatus;

  if (eventType === "job.created") {
    const existingHcpJob = await findExistingCombinedJob(deps.HcpJob, jobId, companyId);
    await deps.calculateLostRevenueInJob(jobId, job, jobStatus, callrailCustomer, company);
    if (existingHcpJob) {
      const callCustomerId = existingHcpJob.toObject().callrailCustomerId;
      if (callCustomerId) {
        // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
        await deps.CallRailCustomer.findOneAndUpdate(
          {
            _id: callCustomerId,
            tags: {
              $nin: [
                "Booked Call",
                "PL - We will call back",
                "PL - Customer will call back",
                "Qualified but not booked",
                "Later Qualified",
              ],
            },
          },
          {
            $addToSet: { tags: "Later Qualified" },
          },
        );
      }
      if (existingHcpJob.jobComponents && existingHcpJob.jobComponents.length > 0) {
        // This is a combined record, update the specific component
        const componentIndex = existingHcpJob.jobComponents.findIndex(
          (comp: any) => comp.hcpId === jobId,
        );

        if (componentIndex >= 0) {
          existingHcpJob.jobComponents[componentIndex] = {
            hcpId: jobId,
            revenue: job.total_amount,
            jobStatus: "created", // Set correct status
            created_at: createdAt,
            updated_at: updatedAt,
            customer: jobDoc.customer,
            assigned_employees: jobDoc.assigned_employees,
            jobCategory: jobDoc.jobCategory,
            jobType: jobDoc.jobType,
            schedule: jobDoc.schedule,
            completed_at: jobDoc.completed_at,
          };
        } else {
          // Add new component if not found
          existingHcpJob.jobComponents.push({
            hcpId: jobId,
            revenue: job.total_amount,
            jobStatus: "created",
            created_at: createdAt,
            updated_at: updatedAt,
            customer: jobDoc.customer,
            assigned_employees: jobDoc.assigned_employees,
            jobCategory: jobDoc.jobCategory,
            jobType: jobDoc.jobType,
            schedule: jobDoc.schedule,
            completed_at: jobDoc.completed_at,
          });
        }

        // Update combined revenue and status
        existingHcpJob.revenue = existingHcpJob.jobComponents.reduce(
          (total: number, comp: any) => total + (comp.revenue || 0),
          0,
        );

        // Update parent record from the primary component
        updateParentJobFromPrimary(existingHcpJob);
        await existingHcpJob.save();
      } else {
        // Regular single job record, update normally
        await deps.HcpJob.updateOne(
          { hcpId: jobId, companyId: company._id },
          {
            $set: {
              jobStatus: "created", // Set correct status
              revenue: job.total_amount,
              customer: jobDoc.customer,
              assigned_employees: jobDoc.assigned_employees,
              jobCategory: jobDoc.jobCategory,
              schedule: jobDoc.schedule,
              completed_at: jobDoc.completed_at,
              created_at: createdAt,
              updated_at: updatedAt,
              companyId: company._id,
            },
          },
        );
      }
    } else {
      // No existing job found
      if (callrailCustomer) {
        if (jobDoc.callrailCustomerId) {
          // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
          await deps.CallRailCustomer.findOneAndUpdate(
            {
              _id: jobDoc.callrailCustomerId,
              tags: {
                $nin: [
                  "Booked Call",
                  "PL - We will call back",
                  "PL - Customer will call back",
                  "Qualified but not booked",
                  "Later Qualified",
                ],
              },
            },
            {
              $addToSet: { tags: "Later Qualified" },
            },
          );
        }
        await createOrCombineJob(jobDoc, "created");
      } else {
        if (callrailCustomer?._id) {
          // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
          await deps.CallRailCustomer.findOneAndUpdate(
            {
              _id: callrailCustomer._id,
              tags: {
                $nin: [
                  "Booked Call",
                  "PL - We will call back",
                  "PL - Customer will call back",
                  "Qualified but not booked",
                  "Later Qualified",
                ],
              },
            },
            {
              $addToSet: { tags: "Later Qualified" },
            },
          );
        }
        await createOrCombineJob(jobDoc, "created");
      }
    }
  } else if (eventType === "job.updated") {
    const existingHcpJob = await findExistingCombinedJob(deps.HcpJob, jobId, companyId);
    await deps.calculateLostRevenueInJob(jobId, job, jobStatus, callrailCustomer, company);

    if (existingHcpJob) {
      const callCustomerId = existingHcpJob.toObject().callrailCustomerId;
      if (callCustomerId) {
        // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
        await deps.CallRailCustomer.findOneAndUpdate(
          {
            _id: callCustomerId,
            tags: {
              $nin: [
                "Booked Call",
                "PL - We will call back",
                "PL - Customer will call back",
                "Qualified but not booked",
                "Later Qualified",
              ],
            },
          },
          {
            $addToSet: { tags: "Later Qualified" },
          },
        );
      }
      // If the existing job doesn't have a call linked, but we found one now, attach it.
      if (!existingHcpJob.callrailCustomerId && callrailCustomer?._id) {
        console.log(
          `🔗 Attaching newly found call ${callrailCustomer._id} to existing job ${jobId}.`,
        );
        if (callrailCustomer?._id) {
          // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
          await deps.CallRailCustomer.findOneAndUpdate(
            {
              _id: callrailCustomer._id,
              tags: {
                $nin: [
                  "Booked Call",
                  "PL - We will call back",
                  "PL - Customer will call back",
                  "Qualified but not booked",
                  "Later Qualified",
                ],
              },
            },
            {
              $addToSet: { tags: "Later Qualified" },
            },
          );
        }
        existingHcpJob.callrailCustomerId = callrailCustomer._id;
        existingHcpJob.matchReason = matchReason;
        existingHcpJob.matchDetails = matchDetails;
      }

      // If jobComponents doesn't exist but parent exists, (for old jobs with 0 components)
      if (!existingHcpJob.jobComponents || existingHcpJob.jobComponents.length === 0) {
        existingHcpJob.jobComponents = [
          {
            hcpId: existingHcpJob.hcpId,
            revenue: existingHcpJob.revenue,
            created_at: existingHcpJob.created_at,
            updated_at: existingHcpJob.updated_at,
            jobStatus: existingHcpJob.jobStatus,
            customer: existingHcpJob.customer,
            assigned_employees: existingHcpJob.assigned_employees,
            jobCategory: existingHcpJob.jobCategory,
            jobType: existingHcpJob.jobType,
            schedule: existingHcpJob.schedule,
            completed_at: existingHcpJob.completed_at,
          },
        ];
      }
      // This is a combined record, update the specific component
      const componentIndex = existingHcpJob.jobComponents.findIndex(
        (comp: any) => comp.hcpId === jobId,
      );

      if (componentIndex >= 0) {
        const existingComponent = existingHcpJob.jobComponents[componentIndex];
        // Continuing from the previous snippet...

        existingHcpJob.jobComponents[componentIndex] = {
          hcpId: jobId,
          revenue: job.total_amount,
          created_at: createdAt,
          jobStatus: existingComponent.jobStatus,
          updated_at: updatedAt,
          customer: jobDoc.customer,
          assigned_employees: jobDoc.assigned_employees,
          jobCategory: jobDoc.jobCategory,
          schedule: jobDoc.schedule,
          completed_at: jobDoc.completed_at,
          jobType: jobDoc.jobType,
        };
      } else {
        // Add new component if not found
        existingHcpJob.jobComponents.push({
          hcpId: jobId,
          revenue: job.total_amount,
          jobStatus: "created",
          created_at: createdAt,
          updated_at: updatedAt,
          customer: jobDoc.customer,
          assigned_employees: jobDoc.assigned_employees,
          jobCategory: jobDoc.jobCategory,
          schedule: jobDoc.schedule,
          completed_at: jobDoc.completed_at,
          jobType: jobDoc.jobType,
        });
      }

      // Update combined revenue
      existingHcpJob.revenue = existingHcpJob.jobComponents.reduce(
        (total: number, comp: any) => total + (comp.revenue || 0),
        0,
      );

      // Update parent record from the primary component
      updateParentJobFromPrimary(existingHcpJob);
      await existingHcpJob.save();
    } else {
      if (callrailCustomer?._id) {
        // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
        await deps.CallRailCustomer.findOneAndUpdate(
          {
            _id: callrailCustomer._id,
            tags: {
              $nin: [
                "Booked Call",
                "PL - We will call back",
                "PL - Customer will call back",
                "Qualified but not booked",
                "Later Qualified",
              ],
            },
          },
          {
            $addToSet: { tags: "Later Qualified" },
          },
        );
      }
      await createOrCombineJob(jobDoc, "created");
    }
  } else if (
    eventType === "job.canceled" ||
    eventType === "job.cancelled" ||
    eventType === "job.deleted"
  ) {
    const existingHcpJob = await findExistingCombinedJob(deps.HcpJob, jobId, companyId);
    await deps.calculateLostRevenueInJob(jobId, job, jobStatus, callrailCustomer, company);
    if (existingHcpJob) {
      // If the existing job doesn't have a call linked, but we found one now, attach it.
      if (!existingHcpJob.callrailCustomerId && callrailCustomer?._id) {
        console.log(
          `🔗 Attaching newly found call ${callrailCustomer._id} to existing job ${jobId} during cancellation.`,
        );
        if (callrailCustomer?._id) {
          // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
          await deps.CallRailCustomer.findOneAndUpdate(
            {
              _id: callrailCustomer._id,
              tags: {
                $nin: [
                  "Booked Call",
                  "PL - We will call back",
                  "PL - Customer will call back",
                  "Qualified but not booked",
                  "Later Qualified",
                ],
              },
            },
            {
              $addToSet: { tags: "Later Qualified" },
            },
          );
        }
        existingHcpJob.callrailCustomerId = callrailCustomer._id;
        existingHcpJob.matchReason = matchReason;
        existingHcpJob.matchDetails = matchDetails;
      }
      const callCustomerId = existingHcpJob?.callrailCustomerId;
      if (callCustomerId) {
        // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
        await deps.CallRailCustomer.findOneAndUpdate(
          {
            _id: callCustomerId,
            tags: {
              $nin: [
                "Booked Call",
                "PL - We will call back",
                "PL - Customer will call back",
                "Qualified but not booked",
                "Later Qualified",
              ],
            },
          },
          {
            $addToSet: { tags: "Later Qualified" },
          },
        );
      }
      if (existingHcpJob.jobComponents && existingHcpJob.jobComponents.length > 0) {
        // This is a combined record, update the specific component status
        const componentIndex = existingHcpJob.jobComponents.findIndex(
          (comp: any) => comp.hcpId === jobId,
        );

        if (componentIndex >= 0) {
          const existingComponent = existingHcpJob.jobComponents[componentIndex];
          existingHcpJob.jobComponents[componentIndex] = {
            ...existingComponent, // Keep existing data like revenue
            hcpId: jobId,
            jobStatus: "canceled", // Set status    don't change this...
            updated_at: updatedAt, // Update timestamp
            // Update other details from the new payload
            customer: jobDoc.customer,
            assigned_employees: jobDoc.assigned_employees,
            jobCategory: jobDoc.jobCategory,
            jobType: jobDoc.jobType,
            schedule: jobDoc.schedule,
            completed_at: jobDoc.completed_at,
          };
        } else {
          // Add new component if not found
          existingHcpJob.jobComponents.push({
            hcpId: jobId,
            revenue: job.total_amount,
            jobStatus: "canceled",
            created_at: createdAt,
            updated_at: updatedAt,
            customer: jobDoc.customer,
            assigned_employees: jobDoc.assigned_employees,
            jobCategory: jobDoc.jobCategory,
            jobType: jobDoc.jobType,
            schedule: jobDoc.schedule,
            completed_at: jobDoc.completed_at,
          });
        }

        // Update combined revenue and status
        existingHcpJob.revenue = existingHcpJob.jobComponents.reduce(
          (total: number, comp: any) => total + (comp.revenue || 0),
          0,
        );

        // Update parent record from the primary component
        updateParentJobFromPrimary(existingHcpJob);
        await existingHcpJob.save();
      } else {
        if (callrailCustomer?._id) {
          // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
          await deps.CallRailCustomer.findOneAndUpdate(
            {
              _id: callrailCustomer._id,
              tags: {
                $nin: [
                  "Booked Call",
                  "PL - We will call back",
                  "PL - Customer will call back",
                  "Qualified but not booked",
                  "Later Qualified",
                ],
              },
            },
            {
              $addToSet: { tags: "Later Qualified" },
            },
          );
        }
        // Regular single job record, update normally
        await deps.HcpJob.updateOne(
          { hcpId: jobId, companyId: company._id },
          {
            $set: {
              jobStatus: "canceled", // Set status
              updated_at: updatedAt, // Update timestamp
              // Update other details from the new payload, but preserve revenue
              customer: jobDoc.customer,
              assigned_employees: jobDoc.assigned_employees,
              jobCategory: jobDoc.jobCategory,
              schedule: jobDoc.schedule,
              completed_at: jobDoc.completed_at,
            },
          },
        );
      }
    } else {
      if (callrailCustomer?._id) {
        // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
        await deps.CallRailCustomer.findOneAndUpdate(
          {
            _id: callrailCustomer._id,
            tags: {
              $nin: [
                "Booked Call",
                "PL - We will call back",
                "PL - Customer will call back",
                "Qualified but not booked",
                "Later Qualified",
              ],
            },
          },
          {
            $addToSet: { tags: "Later Qualified" },
          },
        );
      }
      await createOrCombineJob(jobDoc, "canceled");
    }
  } else if (eventType === "job.completed") {
    const existingHcpJob = await findExistingCombinedJob(deps.HcpJob, jobId, companyId);
    await deps.calculateLostRevenueInJob(jobId, job, jobStatus, callrailCustomer, company);
    if (existingHcpJob) {
      // If the existing job doesn't have a call linked, but we found one now, attach it.
      if (!existingHcpJob.callrailCustomerId && callrailCustomer?._id) {
        console.log(
          `🔗 Attaching newly found call ${callrailCustomer._id} to existing job ${jobId} during completion.`,
        );
        if (callrailCustomer?._id) {
          // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
          await deps.CallRailCustomer.findOneAndUpdate(
            {
              _id: callrailCustomer._id,
              tags: {
                $nin: [
                  "Booked Call",
                  "PL - We will call back",
                  "PL - Customer will call back",
                  "Qualified but not booked",
                  "Later Qualified",
                ],
              },
            },
            {
              $addToSet: { tags: "Later Qualified" },
            },
          );
        }
        existingHcpJob.callrailCustomerId = callrailCustomer._id;
        existingHcpJob.matchReason = matchReason;
        existingHcpJob.matchDetails = matchDetails;
      }
      const callCustomerId = existingHcpJob.toObject().callrailCustomerId;
      if (callCustomerId) {
        // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
        await deps.CallRailCustomer.findOneAndUpdate(
          {
            _id: callCustomerId,
            tags: {
              $nin: [
                "Booked Call",
                "PL - We will call back",
                "PL - Customer will call back",
                "Qualified but not booked",
                "Later Qualified",
              ],
            },
          },
          {
            $addToSet: { tags: "Later Qualified" },
          },
        );
      }
      if (existingHcpJob.jobComponents && existingHcpJob.jobComponents.length > 0) {
        // This is a combined record, update the specific component status
        const componentIndex = existingHcpJob.jobComponents.findIndex(
          (comp: any) => comp.hcpId === jobId,
        );

        if (componentIndex >= 0) {
          existingHcpJob.jobComponents[componentIndex] = jobComponentData;
        } else {
          existingHcpJob.jobComponents.push(jobComponentData);
        }

        // Update combined revenue and status
        existingHcpJob.revenue = existingHcpJob.jobComponents.reduce(
          (total: number, comp: any) => total + (comp.revenue || 0),
          0,
        );

        // Update parent record from the primary component
        updateParentJobFromPrimary(existingHcpJob);
        await existingHcpJob.save();
      } else {
        // Regular single job record, update normally
        if (callrailCustomer?._id) {
          // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
          await deps.CallRailCustomer.findOneAndUpdate(
            {
              _id: callrailCustomer._id,
              tags: {
                $nin: [
                  "Booked Call",
                  "PL - We will call back",
                  "PL - Customer will call back",
                  "Qualified but not booked",
                  "Later Qualified",
                ],
              },
            },
            {
              $addToSet: { tags: "Later Qualified" },
            },
          );
        }
        await deps.HcpJob.updateOne(
          { hcpId: jobId, companyId: company._id },
          {
            $set: {
              jobStatus: "completed",
              revenue: job.total_amount,
              customer: jobDoc.customer,
              assigned_employees: jobDoc.assigned_employees,
              jobCategory: jobDoc.jobCategory,
              jobType: jobDoc.jobType,
              schedule: jobDoc.schedule,
              completed_at: jobDoc.completed_at,
              updated_at: updatedAt,
            },
          },
        );
      }
    } else {
      if (callrailCustomer?._id) {
        // Append "Later Qualified" to tags if none of the excluded tags are present (Because if job is exist that means that call is qualified - so updating the database)
        await deps.CallRailCustomer.findOneAndUpdate(
          {
            _id: callrailCustomer._id,
            tags: {
              $nin: [
                "Booked Call",
                "PL - We will call back",
                "PL - Customer will call back",
                "Qualified but not booked",
                "Later Qualified",
              ],
            },
          },
          {
            $addToSet: { tags: "Later Qualified" },
          },
        );
      }
      await createOrCombineJob(jobDoc, "completed");
    }
  }
}

// Helper functions (exported for external use)

export async function findExistingCombinedJob(
  HcpJob: any,
  jobId: string,
  companyId: string
) {
  let existingJob = await HcpJob.findOne({
    hcpId: jobId,
    companyId: companyId,
  });

  if (existingJob) return existingJob;

  return HcpJob.findOne({
    hcpId: { $regex: `\\b${jobId}\\b`, $options: "i" },
    jobComponents: { $exists: true, $ne: [] },
    companyId: companyId,
  });
}

// List of tags considered qualified (adjust as needed)
const qualifiedTags: string[] = ["qualified"];
const normalizeTags = (tag: string) => tag.toLowerCase().trim();

export async function findMostRecentLinkedCallJob(
  uniqueCallrailCustomers: any[],
  jobTimestamp: Date,
  companyId: string,
  deps: JobProcessorDeps // Note: This function needs deps for HcpJob, so pass it in when calling
) {
  if (!uniqueCallrailCustomers || uniqueCallrailCustomers.length === 0) {
    return null;
  }

  // Separate calls into qualified and non-qualified
  const qualifiedCalls = uniqueCallrailCustomers.filter(call =>
    call.tags?.some((tag: string) => qualifiedTags.includes(normalizeTags(tag))),
  );
  const nonQualifiedCalls = uniqueCallrailCustomers.filter(
    call => !qualifiedCalls.some(qc => qc._id.toString() === call._id.toString()),
  );

  // Sort both lists by most recent first
  const sortCallsByDate = (calls: any[]) =>
    calls.sort((a, b) => {
      const aTime = new Date(a.created_at).getTime();
      const bTime = new Date(b.created_at).getTime();
      return bTime - aTime; // Most recent first
    });

  const sortedQualifiedCalls = sortCallsByDate(qualifiedCalls);
  const sortedNonQualifiedCalls = sortCallsByDate(nonQualifiedCalls);

  // PRIORITY 1: Search for a recent, LINKED, QUALIFIED call within 30 days range.
  console.log(`🔗 Searching for a recent, linked QUALIFIED call to combine with...`);
  for (const call of sortedQualifiedCalls) {
    const existingJob = await deps.HcpJob.findOne({
      callrailCustomerId: call._id,
      companyId: companyId,
    });
    if (existingJob) {
      const daysDifference =
        (jobTimestamp.getTime() - new Date(existingJob.created_at).getTime()) / (1000 * 3600 * 24);

      if (daysDifference >= 0 && daysDifference <= 30) {
        console.log(
          `✅ Found QUALIFIED linked call ${call._id} with job ${existingJob.hcpId}. Combining.`,
        );
        return existingJob;
      }
    }
  }

  // PRIORITY 2: Fallback to searching for a recent, LINKED, NON-QUALIFIED call.
  console.log(`🔗 No qualified calls found. Searching for a recent, linked NON-QUALIFIED call...`);
  for (const call of sortedNonQualifiedCalls) {
    const existingJob = await deps.HcpJob.findOne({
      callrailCustomerId: call._id,
      companyId: companyId,
    });
    if (existingJob) {
      const daysDifference =
        (jobTimestamp.getTime() - new Date(existingJob.created_at).getTime()) / (1000 * 3600 * 24);
      if (daysDifference >= 0 && daysDifference <= 30) {
        console.log(
          `✅ Found NON-QUALIFIED linked call ${call._id} with job ${existingJob.hcpId}. Combining.`,
        );
        return existingJob;
      }
    }
  }

  return null;
}

export function updateParentJobFromPrimary(jobRecord: any) {
  if (!jobRecord || !Array.isArray(jobRecord.jobComponents) || jobRecord.jobComponents.length === 0) {
    return;
  }

  const primaryComponent = findPrimaryJobComponent(jobRecord.jobComponents);

  if (!primaryComponent?._doc) return;

  const newStatus =
    primaryComponent._doc.jobStatus === "updated"
      ? "created"
      : primaryComponent._doc.jobStatus;

  jobRecord.jobStatus = newStatus;
  jobRecord.schedule = primaryComponent._doc.schedule;
  jobRecord.completed_at = primaryComponent._doc.completed_at;
  jobRecord.customer = primaryComponent._doc.customer;
  jobRecord.assigned_employees = primaryComponent._doc.assigned_employees;
  jobRecord.jobCategory = primaryComponent._doc.jobCategory;
  jobRecord.jobType = primaryComponent._doc.jobType;
  jobRecord.created_at = primaryComponent._doc.created_at;
  jobRecord.updated_at = primaryComponent._doc.updated_at;
}

export function findPrimaryJobComponent(components: any[]) {
  if (!components || components.length === 0) return null;
  const now = new Date();

  // 1. Next upcoming job
  const futureJobs = components
    .filter(c => c.schedule?.scheduled_start)
    .map(c => ({ ...c, scheduledDate: new Date(c.schedule.scheduled_start) }))
    .filter(c => !isNaN(c.scheduledDate.getTime()) && c.scheduledDate > now)
    .sort((a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime());

  // Continuing from the previous snippet...

  if (futureJobs.length > 0) return futureJobs[0];

  // 2. Most recent past job
  const pastJobs = components
    .filter(c => c.schedule?.scheduled_start)
    .map(c => ({ ...c, scheduledDate: new Date(c.schedule.scheduled_start) }))
    .filter(c => !isNaN(c.scheduledDate.getTime()) && c.scheduledDate <= now)
    .sort((a, b) => b.scheduledDate.getTime() - a.scheduledDate.getTime());

  if (pastJobs.length > 0) return pastJobs[0];

  // 3. Most recently updated
  const sortedByUpdate = [...components]
    .filter(c => c.updated_at)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  if (sortedByUpdate.length > 0) return sortedByUpdate[0];

  // 4. Most recently created
  const sortedByCreation = [...components]
    .filter(c => c.created_at)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (sortedByCreation.length > 0) return sortedByCreation[0];

  return components[0] || null;
}