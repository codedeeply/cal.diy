import process from "node:process";
import prisma from "@calcom/prisma";
import { createUserAndEventType } from "./seed-utils";

const username = "sgy-971-host";
const email = "sgy-971-host@example.invalid";

async function main(): Promise<void> {
  await createUserAndEventType({
    user: {
      email,
      password: "synthetic-only-not-a-credential",
      username,
      name: "SGY-971 Synthetic Host",
      timeZone: "UTC",
    },
    eventTypes: [
      {
        title: "SGY-971 30 Minute Proof",
        slug: "30-min",
        length: 30,
      },
    ],
  });

  const eventType = await prisma.eventType.findFirstOrThrow({
    where: {
      slug: "30-min",
      users: { some: { username } },
    },
    select: { id: true, length: true, slug: true },
  });

  console.log(JSON.stringify({ seeded: true, username, eventType }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
