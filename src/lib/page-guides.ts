/**
 * What each screen is for, and where it sits in the chain.
 *
 * Every page already carries a one-line description, and there is a 536-line
 * guide at /guide. Neither answers the question people actually ask on arriving
 * at a screen they have not used: *what feeds this, and what does it turn into?*
 * Two of eighty pages mentioned a connection to anything else.
 *
 * That matters here more than in most systems, because almost nothing in this
 * app stands alone — a quote exists because a deal does, a contract because a
 * quote was accepted, commission because a partner was attached to a lead months
 * earlier. Someone who cannot see the chain will create records in the wrong
 * order and then wonder why a dropdown is empty, which is most of the questions
 * asked so far.
 *
 * Kept in one file rather than inline on each page so the chain can be read and
 * corrected as a whole. A wrong `feeds` here is a lie about how the system
 * works, and lies are easier to spot side by side than scattered across eighty
 * files.
 */

export interface PageGuide {
  /** What the screen is for, in one sentence. */
  purpose: string;
  /** What has to exist before this screen is useful. */
  needs?: string[];
  /** What this screen produces or leads to. */
  feeds?: string[];
  /** The thing people get wrong here, where there is one. */
  watchOut?: string;
}

export const PAGE_GUIDES: Record<string, PageGuide> = {
  "/": {
    purpose:
      "The state of the business in one screen - pipeline, cash, delivery load and anything that needs a decision today.",
    needs: ["Records created anywhere else in the app"],
    feeds: ["Nothing - this is a read-only summary"],
    watchOut:
      "Figures are scoped to what your role may see, so two people can correctly see different totals.",
  },

  "/leads": {
    purpose:
      "Unqualified prospects - yours, your team's, and every partner's. Nobody has agreed to anything yet, and no account or deal exists.",
    needs: ["Campaigns, if you want to attribute where a lead came from"],
    feeds: [
      "Converting a lead creates an Account, a Contact and an Opportunity - or, when the person is already a contact, uses that contact and their account",
      "A referring partner carries through to commission on the resulting deal",
      "A partner's leads are every salesperson's to work, whoever owns them - filter by Partner to see one partner's",
    ],
    watchOut:
      "A lead whose email, phone or WhatsApp number is already on a lead or a contact is refused, and you are shown which one. Numbers match on their last nine digits, so +92 300 and 0300 are the same. An import skips those people and lists them.",
  },

  "/campaigns": {
    purpose:
      "Marketing pushes you want to attribute leads and revenue to.",
    feeds: ["Leads reference a campaign, which is what links spend to what it returned"],
  },

  "/accounts": {
    purpose:
      "Organisations you deal with - customers, prospects, partners and vendors, one record with many roles. Every partner's customers are listed, with who brought them.",
    needs: ["Usually created by converting a lead"],
    feeds: ["Opportunities, contracts, projects, invoices and support cases all hang off an account"],
    watchOut:
      "Check whether a company already exists before converting a lead - duplicate accounts split a customer's history and are painful to merge.",
  },

  "/contacts": {
    purpose: "The people at those organisations.",
    needs: ["An account to belong to"],
    feeds: ["Quotations and cases are addressed to a contact"],
    watchOut:
      "A contact whose email, phone, mobile or WhatsApp number is already on another contact is refused, and you are shown which one. One mobile number in any of those boxes counts as the same number.",
  },

  "/opportunities": {
    purpose: "Deals you are working - what might close, for how much, and when. Every partner's deals are here too, whoever owns them.",
    needs: ["An account, usually from converting a lead"],
    feeds: [
      "Quotations are raised against a deal",
      "A partner's deal carries their commission record, and winning one can start a project",
    ],
    watchOut:
      "A deal cannot be marked Closed Won without an amount, at least one product or service, and an accepted quote. Winning it starts its delivery project. Partners close their own deals from the portal by the same rule.",
  },

  "/quotations": {
    purpose: "Versioned, priced offers sent to a customer against one deal.",
    needs: ["A deal to quote against - its products and services become the quote's lines, every value editable"],
    feeds: [
      "Accepting a quote puts its lines on the deal in place of what was there, so the deal's value - and any partner commission - becomes the quote's, and moves the deal to Verbal Confirmation",
      "Contracts are usually built from an accepted quote",
    ],
    watchOut:
      "Once sent, a quote is locked. Change it by revising, which supersedes it with a new version. A quote a partner prepares in the portal cannot be sent until somebody who approves quotations approves it.",
  },

  "/contracts": {
    purpose: "The agreed terms - value, dates, billing frequency and renewal.",
    needs: ["Usually an accepted quotation"],
    feeds: ["Projects deliver against a contract", "Invoices reference it"],
    watchOut:
      "The quote picker is filtered by the customer, so choose the customer first or it will look empty.",
  },

  "/products": {
    purpose:
      "Everything we and our partners sell - BabulTech's products and services, and partners' own. Prices live in price books.",
    feeds: [
      "Deal and quote lines are picked from here and priced from the deal's price book",
      "A service marked Add in Task is sold in hours, and those hours become a project task when the deal is won",
      "Partners see our items read-only in the portal, and keep their own company's items there",
    ],
    watchOut:
      "An item's type is locked once it is priced in a book or sold on a deal: create a new one instead.",
  },

  "/partners": {
    purpose: "Resellers and referrers who bring you business, and work it themselves in the partner portal.",
    feeds: [
      "Each deal credited to a partner gets a commission record at the partner's rate",
      "Partners work their own leads, customers, deals, quotes and items in the portal; every salesperson can see and work them too",
    ],
    watchOut:
      "Only an Active partner gets commission records. Changing a partner's rate applies to their new deals, not ones already running.",
  },

  "/people": {
    purpose: "Everyone hired: their profile, every contract they have had, and what happens when the current one ends.",
    needs: ["The People permissions (Settings › Roles); creating a login also needs an administrator"],
    feeds: [
      "The login gets its role, job title, manager, teams and hourly cost from the contract",
      "A signed contract starts on its start date; the login is switched off the day after the last one ends",
    ],
    watchOut:
      "A contract's wording is frozen once sent. To change it, withdraw it back to draft first. Renew or convert before the end date, or the login goes off.",
  },

  "/commissions": {
    purpose: "One record per partner deal - what the partner is owed on it, and whether it has been paid.",
    needs: ["A deal credited to an Active partner"],
    feeds: ["The partner sees the same record in the portal"],
    watchOut:
      "The payment date is set when the deal is won, 90 days on. Paid and Rejected are final.",
  },

  "/projects": {
    purpose:
      "Delivery engagements - work you do for a customer, and our own internal projects.",
    needs: ["For customer work, an account and usually a contract"],
    feeds: [
      "Milestones become invoices",
      "Logged time becomes billable hours and project cost",
    ],
    watchOut:
      "Only people on the project team can book time to it. Internal projects are never invoiced, and their costs cannot be recharged.",
  },

  "/vault": {
    purpose:
      "The keys, passwords and service logins the business runs on - one place that says who owns each and when it lapses.",
    needs: ["SECRET_VAULT_KEY set in the environment"],
    feeds: [
      "Nothing automatically - this is a register people read",
      "Every reveal is recorded against the person who did it",
    ],
    watchOut:
      "Values are encrypted with a key held outside the database. Lose SECRET_VAULT_KEY and no stored value can be recovered.",
  },

  "/timesheets": {
    purpose: "Your week - what you worked on, for how long, and when.",
    needs: ["A project you are a member of, or a support case"],
    feeds: [
      "Approved billable time can be invoiced",
      "Project cost, margin and utilisation all read these hours",
    ],
    watchOut:
      "Time has to be approved before it can be invoiced. Unapproved hours are revenue sitting still.",
  },

  "/resources": {
    purpose:
      "Who is booked on what, and how much of their capacity is used.",
    needs: ["Project teams and logged time"],
    watchOut: "Shows cost rates, so it is limited to people who approve time.",
  },

  "/cases": {
    purpose: "Customer problems, tracked against an SLA.",
    needs: ["An account, and usually a contact"],
    feeds: ["Time logged against a case feeds support cost"],
  },

  "/data-quality": {
    purpose: "Records missing something that matters, or left alone too long, one rule per card with the oldest first.",
    needs: ["Records you can see - each rule counts only those"],
    feeds: ["Fixing a record takes it off the list straight away"],
    watchOut: "Duplicates are found on their own screens, linked at the top: merging is a judgement, not a fix.",
  },

  "/contacts/duplicates": {
    purpose: "Contacts that look like the same person: same email, same number, or the same name at one account.",
    feeds: ["Merging moves their deals, cases, quotes, activities and files to the contact you keep"],
    watchOut: "A contact with a portal login can only be the one kept, and two people with logins cannot be merged.",
  },

  "/accounts/duplicates": {
    purpose: "Accounts that look like the same company: same name (ignoring Ltd and Pvt), website, tax number or phone.",
    feeds: ["Merging moves contacts, deals, quotes, invoices, payments, projects and cases to the account you keep"],
    watchOut: "A partner's account must be the one kept, and accounts credited to different partners cannot be merged.",
  },

  "/settings/numbering": {
    purpose: "How each kind of record is numbered - prefix, digits, year and the next number.",
    feeds: ["The number every new record gets"],
    watchOut: "The next number only goes up, so a number is never given out twice. Existing records keep theirs.",
  },

  "/settings/integrations": {
    purpose: "Webhooks that tell other systems when something happens here, and the log of every call made.",
    needs: ["An address on the other system that accepts a signed JSON post"],
    feeds: ["A delivery per event per webhook, retried for half a day if the other side is down"],
    watchOut: "Give the receiver the webhook's secret so it can check the signature - and a new one whenever you rotate it.",
  },

  "/knowledge": {
    purpose: "Help articles your team writes once instead of answering the same question on every case.",
    feeds: ["Published articles marked for customers appear under Help articles in the support portal"],
    watchOut: "A draft or an internal article is never shown to customers - publish it and choose customer visibility first.",
  },

  "/activities": {
    purpose: "Calls, meetings and tasks - the touches that move a deal along.",
    feeds: ["Attached to a lead, deal, account or case as its history - including the calls and meetings partners log in the portal"],
  },

  "/invoices": {
    purpose: "What you have billed, and what is still outstanding.",
    needs: ["Something to bill - a milestone, approved time, or a contract"],
    feeds: ["Payments are allocated against invoices"],
    watchOut:
      "A draft invoice can be edited; once issued it cannot. Reverse it with a credit note instead.",
  },

  "/payments": {
    purpose: "Money received, and which invoices it settles.",
    needs: ["An issued invoice"],
    feeds: ["Allocation clears an invoice's outstanding amount"],
    watchOut:
      "A payment and its allocation are separate: one payment often settles several invoices.",
  },

  "/vendor-bills": {
    purpose: "What your suppliers have billed you.",
    feeds: ["Vendor payments, and project cost where a bill is attributed to one"],
  },

  "/expenses": {
    purpose: "Money your people spent that needs reimbursing or attributing.",
    needs: ["An expense category, and a project if the cost is billable"],
    feeds: ["Approved expenses become project cost, and billable ones can be invoiced on"],
    watchOut: "Nobody can approve their own claim, whatever their role.",
  },

  "/approvals": {
    purpose:
      "Everything waiting on you - quotes partners prepared, expenses, time, bills and commission, in one queue.",
    needs: ["An approval permission for the kind of record"],
    feeds: ["Approving here unblocks invoicing and payment elsewhere"],
  },

  "/my-work": {
    purpose: "Your tasks, activities and follow-ups across every module.",
  },

  "/users": {
    purpose: "Who can sign in, and what their role lets them see and do.",
    feeds: [
      "Role decides both permissions and how much data a person sees",
      "A Partner-role user is linked to a partner record and sees only the portal",
    ],
    watchOut:
      "Data scope matters as much as permissions: OWN, TEAM, DEPARTMENT or ALL decides whose records appear.",
  },

  "/settings": {
    purpose:
      "The lists the rest of the app chooses from - categories, tax rates, currencies, numbering and SLA policies.",
    feeds: ["Almost every dropdown in the system reads from here"],
  },
  "/notifications": {
    purpose:
      "Everything that came your way: work assigned to you, approvals, customers' replies, and changes to records you follow. Kept for 90 days.",
    needs: ["Records assigned to you, or records you follow"],
    feeds: ["The record each notification is about - click one to open it"],
    watchOut: "You are never told about something you did yourself.",
  },
  "/notifications/settings": {
    purpose: "Choose, for each kind of notification, whether it shows under the bell and whether it also comes by email.",
    feeds: ["The bell, and the one-digest emails the scheduler sends"],
    watchOut:
      "Emails only go out once an administrator has set the site's public address on the Background jobs page.",
  },
  "/jobs": {
    purpose: "Work that runs in the background - mass emails, and later imports - with its progress and any errors.",
    needs: ["For administrators: the site's public address, so the scheduler can call it"],
    feeds: ["The send's page for a mass email, and a notification when a job finishes"],
    watchOut: "A job you stop keeps whatever it already did: emails already sent stay sent.",
  },
  "/recycle-bin": {
    purpose:
      "Deleted leads, accounts, contacts, deals, cases and campaigns, restorable for 90 days before they are erased for good.",
    needs: ["A delete permission for that kind of record"],
    feeds: ["The record, back where it was, when restored"],
    watchOut:
      "Some records cannot be deleted at all - a converted lead, a won deal, an account with invoices. The Delete button says why on hover.",
  },
  "/activity-log": {
    purpose: "The permanent audit trail: emails, records, changes, sign-ins, timesheets and system work. Administrators see everything; others see their own actions.",
  },
  "/users/security": {
    purpose: "Every sign-in, failed sign-in and sign-out, and every View as session with its reason.",
    feeds: ["Nothing - this is a record for checking"],
    watchOut: "A run of failed sign-ins for one address is worth asking that person about.",
  },
  "/campaigns/dashboard": {
    purpose:
      "Every campaign from first touch to won revenue - members, engaged, leads, qualified, won, spend and ROI - with child campaigns added into their parent.",
    needs: ["Campaigns with spend recorded, and leads and deals that name them"],
    feeds: ["The campaign pages, one click in"],
    watchOut:
      "Revenue depends on how a deal is credited. Primary uses the deal's own campaign; first, lead-creation and latest touch use the campaigns the lead came through.",
  },
  "/campaigns/forms": {
    purpose: "The forms on your website that send sign-ups here as prospects, each belonging to a campaign.",
    needs: ["A campaign: forms are added from its page"],
    feeds: ["Prospects, with where they came from, and a touch on anyone already on file"],
  },
  "/campaigns/scoring": {
    purpose: "The points a lead earns from what it does and who it is, and the score at which it counts as hot.",
    feeds: ["Each lead's score, the hot-lead notification, and - if switched on - prospects moving to New by themselves"],
    watchOut: "Changing a rule re-scores every open lead at once.",
  },
  "/leads/referrals": {
    purpose: "Who sends us business: contacts named as a lead's referrer, and partners who registered leads.",
    needs: ["Referred by set on the lead, or a partner registration"],
    feeds: ["Nothing - a report"],
  },
  "/email/compose": {
    purpose: "One email to many people - leads, contacts or campaign members - each getting their own copy with their own unsubscribe link.",
    needs: ["People chosen on a list, or one person from their page", "A sender address (Admin › Sender addresses)"],
    feeds: ["The send's page, with who opened and clicked", "A touch on each person when they open or click"],
    watchOut: "Anyone unsubscribed, bounced or opted out is left out, and so are contacts who have not agreed to marketing unless you untick that box.",
  },
  "/email/templates": {
    purpose: "Saved subjects and messages to start an email from, with placeholders each person's details fill in.",
    feeds: ["The template choice when composing"],
  },
  "/email/senders": {
    purpose: "The names and addresses mass email can be sent as, such as Sales and Support.",
    watchOut: "Addresses must be on the domain the mail provider sends for, or they are refused.",
  },
  "/leads/board": {
    purpose: "Open leads in columns by status. Drag a card, or use its Move to list.",
    feeds: ["The lead's status, exactly as changing it on the lead would"],
    watchOut: "Converting and disqualifying are done on the lead itself, where they ask what they need.",
  },
  "/opportunities/board": {
    purpose: "The pipeline in columns by stage, with each column's value.",
    feeds: ["The deal's stage, with the same checks as its own page"],
    watchOut: "A deal moves to Won only with its products and an accepted quote; moving one to Lost asks why.",
  },
  "/cases/board": {
    purpose: "Open cases in columns by status.",
    watchOut: "Moving a case to Resolved asks what fixed it.",
  },
  "/my-work/board": {
    purpose: "Your project tasks in columns by status. Completing one sets it to 100%.",
  },
  "/reports": {
    purpose: "Ready-made reports, each with filters and a CSV download, and the ones you have asked to receive.",
    watchOut: "Reports show what your role may see, so two people can get different figures.",
  },
  "/settings/automation": {
    purpose: "When a quote needs approval before it is sent, and the automatic rules: sharing website leads, follow-up and stale-deal reminders, case response warnings.",
    feeds: ["Approvals", "Reminders under the bell", "The log of what the rules did"],
    watchOut: "Every automatic rule starts switched off.",
  },
};

/**
 * The guide for a path, matched longest-prefix first.
 *
 * A detail page inherits its list's guide — /leads/abc123 is still the leads
 * screen as far as "how does this fit together" goes, and writing a separate
 * entry for every record would be both impossible and pointless.
 */
export function guideFor(pathname: string): PageGuide | null {
  if (PAGE_GUIDES[pathname]) return PAGE_GUIDES[pathname];

  const match = Object.keys(PAGE_GUIDES)
    .filter((key) => key !== "/" && pathname.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];

  return match ? PAGE_GUIDES[match] : null;
}
