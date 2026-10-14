
"use server";

import * as cheerio from "cheerio";

interface StudentResult {
  rollNumber: string;
  studentName: string;
  subjects: Array<{ subject: string; mark: string | number }>;
  totalPercentage: string | number;
  finalStatus: string;
}

// Determine whether the roll number belongs to 2022 or later.
function is2022OrLater(rollNumber: string): boolean {
  return /^(22|23|24)/.test(rollNumber);
}

export async function getStudentResult(
  formData: FormData
): Promise<StudentResult> {
  const rollNumber = formData.get("rollNumber")?.toString().trim();

  if (!rollNumber) {
    throw new Error("Roll Number is required");
  }

  // SONEB roll numbers are expected to contain eight digits.
  if (!/^\d{8}$/.test(rollNumber)) {
    throw new Error("Please enter a valid 8-digit roll number");
  }

  try {
    // Encode the query parameter safely.
    const params = new URLSearchParams({
      q: `(RollNumber~equals~${rollNumber})`,
    });

    const url =
      `https://soneb.gov.so/natiijada_ardayga_list.php?${params.toString()}`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/html",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      console.error("[SONEB] Request failed:", {
        status: res.status,
        statusText: res.statusText,
      });

      if (res.status === 403) {
        throw new Error(
          "SONEB denied the request (403 Forbidden). Please try again later."
        );
      }

      throw new Error(
        `Failed to fetch results: ${res.status} ${res.statusText}`
      );
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // Detect an explicit no-results message.
    const notFoundMessage = $("[data-grid-message]").text().trim();

    if (notFoundMessage.includes("Xog lamasoo helin")) {
      throw new Error("Student not found");
    }

    // Extract student name.
    const studentName = $("#edit4_StudentName").text().trim();

    if (!studentName) {
      throw new Error(
        "Student result was not found in the SONEB response"
      );
    }

    // Extract subjects and marks.
    const subjects: Array<{
      subject: string;
      mark: string | number;
    }> = [];

    const subjectRows = $("table.bs-fieldsgrid tr");
    const isNewFormat = is2022OrLater(rollNumber);

    subjectRows.each((_, element) => {
      const tds = $(element).find("td");

      if (tds.length >= 4) {
        const subject1 = $(tds[0]).text().trim();
        const mark1Text = $(tds[1]).text().trim();
        const subject2 = $(tds[2]).text().trim();
        const mark2Text = $(tds[3]).text().trim();

        if (subject1) {
          if (isNewFormat) {
            subjects.push({
              subject: subject1,
              mark: mark1Text,
            });
          } else {
            const mark = parseFloat(mark1Text);

            if (!Number.isNaN(mark)) {
              subjects.push({
                subject: subject1,
                mark,
              });
            }
          }
        }

        if (subject2) {
          if (isNewFormat) {
            subjects.push({
              subject: subject2,
              mark: mark2Text,
            });
          } else {
            const mark = parseFloat(mark2Text);

            if (!Number.isNaN(mark)) {
              subjects.push({
                subject: subject2,
                mark,
              });
            }
          }
        }
      } else if (tds.length >= 2 && subjects.length < 10) {
        const subject = $(tds[0]).text().trim();
        const markText = $(tds[1]).text().trim();

        if (subject) {
          if (isNewFormat) {
            subjects.push({
              subject,
              mark: markText,
            });
          } else {
            const mark = parseFloat(markText);

            if (!Number.isNaN(mark)) {
              subjects.push({
                subject,
                mark,
              });
            }
          }
        }
      }
    });

    if (subjects.length === 0) {
      throw new Error("No subjects found for this student");
    }

    // Extract percentage or letter grade.
    const percentageText = $("#edit4_Celceliska").text().trim();

    let totalPercentage: string | number;

    if (isNewFormat) {
      totalPercentage = percentageText;
    } else {
      const percentage = parseFloat(
        percentageText.replace("%", "").trim()
      );

      if (Number.isNaN(percentage)) {
        throw new Error("Invalid percentage data");
      }

      totalPercentage = percentage;
    }

    // Extract final result status.
    const status = $("#edit4_Natiijada").text().trim();

    if (!status) {
      throw new Error("No status found for this student");
    }

    return {
      rollNumber,
      studentName,
      subjects,
      totalPercentage,
      finalStatus: status,
    };
  } catch (error) {
    if (error instanceof Error) {
      // Preserve meaningful application errors without wrapping them repeatedly.
      throw error;
    }

    throw new Error(
      "An unexpected error occurred while fetching student results"
    );
  }
}
