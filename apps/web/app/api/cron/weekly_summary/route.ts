import { responses } from "@/lib/api/response";
import { prisma } from "@formbricks/database";
import { CRON_SECRET } from "@formbricks/lib/constants";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { sendNoLiveSurveyNotificationEmail, sendWeeklySummaryNotificationEmail } from "./email";

interface Insights {
  totalCompletedResponses: number;
  totalDisplays: number;
  totalResponses: number;
  completionRate: number;
  numLiveSurvey: number;
}

interface SurveyData {
  id: string;
  name: string;
  responses: { headline: string; answer: string }[];
}

interface NotificationResponse {
  environmentId: string;
  currentDate: Date;
  lastWeekDate: Date;
  productName: string;
  surveys: SurveyData[];
  insights: Insights;
}

export async function POST(): Promise<NextResponse> {
  // check authentication with x-api-key header and CRON_SECRET env variable
  if (headers().get("x-api-key") !== CRON_SECRET) {
    return responses.notAuthenticatedResponse();
  }

  // list of email sending promises to wait for
  const emailSendingPromises: Promise<void>[] = [];

  const products = await getProducts();

  // iterate through the products and send weekly summary email to each team member
  for await (const product of products) {
    // check if there are team members that have weekly summary notification enabled
    const teamMembers = product.team.memberships;
    const teamMembersWithNotificationEnabled = teamMembers.filter((member) => {
      return (
        member.user.notificationSettings?.weeklySummary &&
        member.user.notificationSettings.weeklySummary[product.id]
      );
    });
    // if there are no team members with weekly summary notification enabled, skip to the next product (do not send email)
    if (teamMembersWithNotificationEnabled.length == 0) {
      continue;
    }
    // calculate insights for the product
    const insights = {
      totalCompletedResponses: 0,
      totalDisplays: 0,
      totalResponses: 0,
      completionRate: 0,
      numLiveSurvey: 0,
    };
    const environment = product.environments[0];
    const surveys: SurveyData[] = [];

    // iterate through the surveys and calculate the overall insights
    for await (const survey of environment.surveys) {
      const surveyData: SurveyData = {
        id: survey.id,
        name: survey.name,
        responses: [],
      };
      // iterate through the responses and calculate the survey insights
      for await (const response of survey.responses) {
        for await (const question of survey.questions) {
          const headline = question.headline;
          const answer = response.data[question.id] || null;
          surveyData.responses.push({ headline: headline, answer });
        }
      }
      surveys.push(surveyData);
      // calculate the overall insights
      if (survey.status == "live") {
        insights.numLiveSurvey += 1;
      }
      insights.totalCompletedResponses += survey.responses.filter((r) => r.finished).length;
      insights.totalDisplays += survey.displays.length;
      insights.totalResponses += survey.responses.length;
      insights.completionRate = Math.round((insights.totalCompletedResponses / insights.totalDisplays) * 100);
    }
    // if there were no responses in the last 7 days, send a different email
    if (insights.totalCompletedResponses == 0) {
      for (const teamMember of teamMembersWithNotificationEnabled) {
        emailSendingPromises.push(sendNoLiveSurveyNotificationEmail(teamMember.user.email, product));
      }
      emailSendingPromises.push(
        sendNoLiveSurveyNotificationEmail(teamMembersWithNotificationEnabled, product)
      );
      continue;
    }
    // prepare weekly summary email
    const lastWeekDate = new Date();
    lastWeekDate.setDate(lastWeekDate.getDate() - 7);
    const notificationResponse: NotificationResponse = {
      environmentId: environment.id,
      currentDate: new Date(),
      lastWeekDate,
      productName: product.name,
      surveys,
      insights,
    };
    // send weekly summary email
    emailSendingPromises.push(
      sendWeeklySummaryNotificationEmail(teamMembersWithNotificationEnabled, notificationResponse)
    );
  }
  // wait for all emails to be sent
  await Promise.all(emailSendingPromises);
  return responses.successResponse({}, true);
}

const getProducts = async () => {
  // gets all products together with team members, surveys, responses, and displays for the last 7 days
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  return await prisma.product.findMany({
    select: {
      id: true,
      environments: {
        where: {
          type: "production",
        },
        select: {
          id: true,
          surveys: {
            where: {
              status: {
                not: "draft",
              },
            },
            select: {
              name: true,
              questions: true,
              status: true,
              responses: {
                where: {
                  createdAt: {
                    gte: sevenDaysAgo,
                  },
                },
                select: {
                  id: true,
                  createdAt: true,
                  updatedAt: true,
                  finished: true,
                  data: true,
                },
              },
              displays: {
                select: {
                  status: true,
                },
              },
            },
          },
        },
      },
      team: {
        select: {
          memberships: {
            select: {
              user: {
                select: {
                  email: true,
                  notificationSettings: true,
                },
              },
            },
          },
        },
      },
    },
  });
};
