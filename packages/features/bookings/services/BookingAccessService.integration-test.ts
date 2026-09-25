import { randomUUID } from "node:crypto";
import process from "node:process";
import prisma from "@calcom/prisma";
import type { MembershipRole } from "@calcom/prisma/enums";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BookingAccessService } from "./BookingAccessService";

const userIds: number[] = [];
const teamIds: number[] = [];
const eventIds: number[] = [];
const bookingIds: number[] = [];
const actors = new Map<string, { id: number; email: string }>();
const bookings = new Map<string, { id: number; uid: string }>();
const service = new BookingAccessService(prisma);
let teamId: number;
let orgId: number;
let fixtureDatabaseVerified = false;
const actor = (name: string) => {
  const user = actors.get(name);
  if (!user) throw new Error(`Missing synthetic actor: ${name}`);
  return user;
};
const booking = (name: string) => {
  const value = bookings.get(name);
  if (!value) throw new Error(`Missing synthetic booking: ${name}`);
  return value;
};
const access = (name: string, kind: string) =>
  service.doesUserIdHaveAccessToBooking({
    userId: actor(name).id,
    bookingUid: booking(kind).uid,
  });

describe("BookingAccessService real membership enforcement", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || "");
    expect(["localhost", "127.0.0.1", "sle118-closure-db"]).toContain(url.hostname);
    expect(url.pathname).toBe("/sle118_authz_test");
    fixtureDatabaseVerified = true;
    const suffix = randomUUID();
    for (const name of [
      "organizer",
      "host",
      "poolHost",
      "attendee",
      "outsider",
      "teamAdmin",
      "teamOwner",
      "teamMember",
      "pendingAdmin",
      "orgAdmin",
      "orgOwner",
      "orgMember",
      "pendingOrgAdmin",
      "foreignAdmin",
    ]) {
      const user = await prisma.user.create({
        data: { email: `${name}-${suffix}@example.invalid` },
        select: { id: true, email: true },
      });
      actors.set(name, user);
      userIds.push(user.id);
    }
    async function createTeam(isOrganization: boolean, parentId?: number) {
      const team = await prisma.team.create({
        data: { name: `Synthetic ${suffix}`, isOrganization, parentId },
        select: { id: true },
      });
      teamIds.push(team.id);
      return team.id;
    }
    orgId = await createTeam(true);
    teamId = await createTeam(false, orgId);
    const foreignOrg = await createTeam(true);
    async function member(name: string, id: number, role: MembershipRole, accepted = true) {
      await prisma.membership.create({
        data: { userId: actor(name).id, teamId: id, role, accepted },
        select: { id: true },
      });
    }
    await member("organizer", teamId, "MEMBER");
    await member("organizer", orgId, "MEMBER");
    await member("teamAdmin", teamId, "ADMIN");
    await member("teamOwner", teamId, "OWNER");
    await member("teamMember", teamId, "MEMBER");
    await member("pendingAdmin", teamId, "ADMIN", false);
    await member("orgAdmin", orgId, "ADMIN");
    await member("orgOwner", orgId, "OWNER");
    await member("orgMember", orgId, "MEMBER");
    await member("pendingOrgAdmin", orgId, "ADMIN", false);
    await member("foreignAdmin", foreignOrg, "OWNER");
    await prisma.user.update({
      where: { id: actor("organizer").id },
      data: { organizationId: orgId },
      select: { id: true },
    });
    async function event(kind: string, eventTeamId?: number, parentId?: number) {
      const result = await prisma.eventType.create({
        data: {
          title: "Synthetic authorization event",
          slug: `${kind}-${suffix}`,
          length: 30,
          userId: actor("organizer").id,
          teamId: eventTeamId,
          parentId,
          hosts: { create: { userId: actor("host").id } },
          users: { connect: [{ id: actor("host").id }, { id: actor("poolHost").id }] },
        },
        select: { id: true },
      });
      eventIds.push(result.id);
      return result.id;
    }
    const teamEvent = await event("team", teamId);
    const managedEvent = await event("managed", undefined, teamEvent);
    const personalEvent = await event("personal");
    for (const [kind, eventTypeId] of [
      ["team", teamEvent],
      ["managed", managedEvent],
      ["personal", personalEvent],
      ["noOwner", null],
    ] as const) {
      const result = await prisma.booking.create({
        data: {
          uid: `${kind}-${suffix}`,
          title: "Synthetic authorization booking",
          eventTypeId,
          userId: kind === "noOwner" ? null : actor("organizer").id,
          startTime: new Date("2030-01-01T10:00:00Z"),
          endTime: new Date("2030-01-01T10:30:00Z"),
          attendees: {
            create: ["host", "attendee"].map((name) => ({
              email: actor(name).email,
              name: "Synthetic attendee",
              timeZone: "UTC",
            })),
          },
        },
        select: { id: true, uid: true },
      });
      bookings.set(kind, result);
      bookingIds.push(result.id);
    }
  });

  afterAll(async () => {
    if (!fixtureDatabaseVerified) return;
    // Only IDs created by this run may be removed, including after a failed assertion.
    await prisma.attendee.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    await prisma.host.deleteMany({ where: { eventTypeId: { in: eventIds } } });
    for (const id of [...eventIds].reverse()) await prisma.eventType.delete({ where: { id } });
    await prisma.membership.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    for (const id of [...teamIds].reverse()) await prisma.team.delete({ where: { id } });
    await prisma.$disconnect();
  });

  describe.each(["team", "managed", "personal"])("%s booking", (kind) => {
    it.each([
      "organizer",
      "host",
      "teamAdmin",
      "teamOwner",
      "orgAdmin",
      "orgOwner",
    ])("allows %s using the actual permission path", async (name) => {
      expect(await access(name, kind)).toBe(true);
    });
    it.each([
      "outsider",
      "attendee",
      "poolHost",
      "teamMember",
      "pendingAdmin",
      "orgMember",
      "pendingOrgAdmin",
      "foreignAdmin",
    ])("denies %s using the actual permission path", async (name) => {
      expect(await access(name, kind)).toBe(false);
    });
  });

  it("enforces the same denial through booking ID lookup", async () => {
    expect(
      await service.doesUserIdHaveAccessToBooking({
        userId: actor("outsider").id,
        bookingId: booking("team").id,
      })
    ).toBe(false);
  });

  it("allows a participating legacy event user without a Host row", async () => {
    await prisma.host.deleteMany({ where: { eventTypeId: { in: eventIds }, userId: actor("host").id } });
    for (const kind of ["team", "managed", "personal"]) expect(await access("host", kind)).toBe(true);
  });

  it("does not inherit administrative access from a parent that is not an organization", async () => {
    await prisma.team.update({ where: { id: orgId }, data: { isOrganization: false }, select: { id: true } });
    try {
      expect(await access("orgAdmin", "team")).toBe(false);
      expect(await access("orgAdmin", "managed")).toBe(false);
      expect(await access("teamAdmin", "team")).toBe(true);
    } finally {
      await prisma.team.update({
        where: { id: orgId },
        data: { isOrganization: true },
        select: { id: true },
      });
    }
  });

  it("denies absent booking selectors, missing bookings and missing organizers", async () => {
    expect(await service.doesUserIdHaveAccessToBooking({ userId: actor("outsider").id })).toBe(false);
    expect(
      await service.doesUserIdHaveAccessToBooking({
        userId: actor("outsider").id,
        bookingUid: randomUUID(),
      })
    ).toBe(false);
    expect(await access("orgAdmin", "noOwner")).toBe(false);
  });

  it("does not grant personal-booking access through the organizer's pending memberships", async () => {
    await prisma.membership.updateMany({
      where: { userId: actor("organizer").id },
      data: { accepted: false },
    });
    try {
      expect(await access("teamAdmin", "personal")).toBe(false);
      expect(await access("orgAdmin", "personal")).toBe(false);
      expect(await access("organizer", "personal")).toBe(true);
    } finally {
      await prisma.membership.updateMany({
        where: { userId: actor("organizer").id },
        data: { accepted: true },
      });
    }
  });

  it("immediately denies a downgraded team admin and a revoked parent-org admin", async () => {
    await prisma.membership.updateMany({
      where: { userId: actor("teamAdmin").id },
      data: { role: "MEMBER" },
    });
    await prisma.membership.updateMany({
      where: { userId: actor("orgAdmin").id },
      data: { accepted: false },
    });
    try {
      for (const kind of ["team", "managed", "personal"]) {
        expect(await access("teamAdmin", kind)).toBe(false);
        expect(await access("orgAdmin", kind)).toBe(false);
      }
    } finally {
      await prisma.membership.updateMany({
        where: { userId: actor("teamAdmin").id },
        data: { role: "ADMIN" },
      });
      await prisma.membership.updateMany({
        where: { userId: actor("orgAdmin").id },
        data: { accepted: true },
      });
    }
  });
});
