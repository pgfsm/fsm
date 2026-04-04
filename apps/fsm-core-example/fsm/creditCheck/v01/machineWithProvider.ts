import { fromPromise, setup } from "xstate";
import {
  checkBureau,
  checkReportsTable,
  determineMiddleScore,
  generateInterestRates,
  verifyCredentials,
} from "./typescript/actors/index.ts";

import {
  assignSSN,
  assignFirstName,
  assignLastName,
  assignErrorMessage,
  assignEquiGavinScore,
  assignEquiGavinScoreFetch,
  assignGavUnionScore,
  assignGavUnionScoreFetch,
  assignGavperianScore,
  assignGavperianScoreFetch,
  assignMiddleScore,
  assignInterestRateOptions,
  saveReportEquiGavin,
  saveReportGavUnion,
  saveReportGavperian,
  saveCreditProfile,
  emailUser,
  emailSalesTeam,
  // assignCreditScoreError,
} from "./typescript/actions/index.ts";

import { allSucceeded, gavUnionReportFound, equiGavinReportFound, gavperianReportFound } from "./typescript/guards/index.ts";
import { machine } from "./machine.ts";
export const machineWithProvider = machine.provide({
  // types: {
    
  //   context: {} as {
  //     SSN: string;
  //     FirstName: string;
  //     LastName: string;
  //     GavUnionScore: number;
  //     EquiGavinScore: number;
  //     GavperianScore: number;
  //     ErrorMessage: string;
  //     MiddleScore: number;
  //     InterestRateOptions: number[];
  //   },
  // },

  actors: {
    verifyCredentials: fromPromise(
      async ({ input }: { input: { SSN: string; firstName: string; lastName: string } }) =>
        await verifyCredentials(input),
    ),
    checkReportsTable: fromPromise(
      async ({ input }: { input: { ssn: string; bureauName: string } }) =>
        await checkReportsTable(input),
    ),
    checkBureau: fromPromise(
      async ({ input }: { input: { ssn: string; bureauName: string } }) =>
        await checkBureau(input),
    ),
    determineMiddleScore: fromPromise(
      async ({ input }: { input: number[] }) =>
        await determineMiddleScore(input),
    ),
    generateInterestRates: fromPromise(
      async ({ input }: { input: number }) =>
        await generateInterestRates(input),
    ),
  },

  actions: {
    assignSSN,
    assignFirstName,
    assignLastName,
    assignErrorMessage,
    assignEquiGavinScore,
    assignEquiGavinScoreFetch,
    assignGavUnionScore,
    assignGavUnionScoreFetch,
    assignGavperianScore,
    assignGavperianScoreFetch,
    assignMiddleScore,
    assignInterestRateOptions,
    saveReportEquiGavin,
    saveReportGavUnion,
    saveReportGavperian,
    saveCreditProfile,
    emailUser,
    emailSalesTeam,
    // assignCreditScoreError,
  },

  guards: {
    allSucceeded,
    gavUnionReportFound,
    equiGavinReportFound,
    gavperianReportFound,
  },
})
