import { assign, createMachine, fromPromise } from "xstate";

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkTirePressure() {
  console.log("Starting checkTirePressure");
  await delay(1000);
  console.log("Completed checkTirePressure");
  return { value: 100 };
}

async function checkOilPressure() {
  console.log("Starting checkOilPressure");
  await delay(1500);
  console.log("Completed checkOilPressure");
  return { value: 100 };
}

async function checkCoolantLevel() {
  console.log("Starting checkCoolantLevel");
  await delay(500);
  console.log("Completed checkCoolantLevel");
  return { value: 100 };
}

async function checkBattery() {
  console.log("Starting checkBattery");
  await delay(1200);
  console.log("Completed checkBattery");
  return { value: 100 };
}

function assignTirePressure({ event }: { event: any }) {
  return { tirePressure: event.output };
}

function assignOilPressure({ event }: { event: any }) {
  return { oilPressure: event.output };
}

function assignCoolantLevel({ event }: { event: any }) {
  return { coolantLevel: event.output };
}

function assignBattery({ event }: { event: any }) {
  return { battery: event.output };
}

function allVitalsAvailable({ context }: { context: any }) {
  return !!(
    context.tirePressure &&
    context.oilPressure &&
    context.coolantLevel &&
    context.battery
  );
}

function outputContext({ context }: { context: any }) {
  return context;
}

const vitalsWorkflow = createMachine(
  {
    /** @xstate-layout N4IgpgJg5mDOIC5QDcCWAXAhgG1gYwAsw8BrAOgGEjSA1DHWAYggHsA7MM1N5FkztFlyFi5KqLpDYCbrzyZ0qdgG0ADAF016xKAAOLWBiVsdIAB6IAbACYy1ywE4ArAGYAjJYAcDy2+svLABYAGhAAT0QAtzJPJwcXT3cAdn84twBfdNDBBhFSSmoSSQZmdk5ZPgF6YUKCiWrpCvlFFTdNDVN9QxaTJHMrJzJLJKckzzcxpOHPTyTQiIR7TzJA1RsnJ09rJJdVBx9M7Ia8sULi3FKOLh5Kshya0TraBpkb5uNla3btPq6jdlMFgQllUZCcbic6wSDjcEzcqic80QE0CZGc7msnkCW3sqk8hxA93wtXEzykl3KN34d2OJLOLyaCg+Lm+nQM-16oCBYzIqiSgWsbh8gUClncDk8SIQ4zBqjlqlhLhSsKCBKJJyeRQajC0bO6xkBiGsziG2JFqy2W0cUqc1lRkOs4P841GE0yWRAbBYEDgpnVhT1HMNCAAtG4pSHLGraY9SVqpIGesHAnNwohRaCMeCESi8dto1INedYHHIImDX0gYF4WQXC44qLLEEHIFwSE0whbdEHU7MXi1u70kA */
    id: "vitalscheck",
    context: {
      tirePressure: null,
      oilPressure: null,
      coolantLevel: null,
      battery: null,
    },
    initial: "CheckVitals",
    states: {
      CheckVitals: {
        invoke: [
          {
            src: "checkTirePressure",
            onDone: { actions: "assignTirePressure" },
          },
          {
            src: "checkOilPressure",
            onDone: { actions: "assignOilPressure" },
          },
          {
            src: "checkCoolantLevel",
            onDone: { actions: "assignCoolantLevel" },
          },
          {
            src: "checkBattery",
            onDone: { actions: "assignBattery" },
          },
        ],
        always: {
          guard: "allVitalsAvailable",
          target: "VitalsChecked",
        },
      },
      VitalsChecked: {
        type: "final",
        output: outputContext,
      },
    },
  },
  {
    actions: {
      assignTirePressure: assign(assignTirePressure),
      assignOilPressure: assign(assignOilPressure),
      assignCoolantLevel: assign(assignCoolantLevel),
      assignBattery: assign(assignBattery),
    },
    actors: {
      checkTirePressure: fromPromise(checkTirePressure),
      checkOilPressure: fromPromise(checkOilPressure),
      checkCoolantLevel: fromPromise(checkCoolantLevel),
      checkBattery: fromPromise(checkBattery),
    },
    guards: {
      allVitalsAvailable,
    },
  },
);

export default vitalsWorkflow;
