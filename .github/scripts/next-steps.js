// Maintains a single sticky "next steps" comment on an issue, mirroring Trac's
// per-stage guidance box. Reads the current Triage stage (+ Flags, for the
// three Accepted sub-queues) and rewrites the comment in place, so there is no
// noise on repeated runs.
//
// The guidance text quotes Django's triaging-tickets documentation verbatim.
//
// Three callers cover every stage change, whatever its source:
//   - next-steps.yml            (human / web-UI field changes, via field_added)
//   - triage-bot.yml            (after the bot changes a stage with GITHUB_TOKEN)
//   - apply-issue-form.yml      (after setting a new ticket's fields)
// The latter two matter because field changes made with GITHUB_TOKEN do not
// themselves trigger further workflow runs.

const MARKER = '<!-- triage-next-steps -->';

function guidanceFor(stage, flags, hasPatch) {
  if (stage === 'Unreviewed') {
    return "**Unreviewed** — The ticket has not been reviewed by anyone who felt " +
      "qualified to make a judgment about whether the ticket contained a valid " +
      "issue or ought to be closed. Unless you are both the author of the ticket " +
      "and intending to submit a patch, unreviewed tickets should not be claimed.";
  }
  if (stage === 'Accepted') {
    const needsWork = flags.has('Needs tests') ||
      flags.has('Needs documentation') || flags.has('Patch needs improvement');
    if (!hasPatch) {
      return "**Accepted · Needs patch** — The ticket is valid, but no one has " +
        "submitted a patch for it yet. Often this means you could safely start " +
        "writing a fix for it.";
    }
    if (needsWork) {
      return "**Accepted · Waiting on author** — The ticket has been reviewed, and " +
        "has been found to need further work. \"Needs tests\" and \"Needs " +
        "documentation\" are self-explanatory. \"Patch needs improvement\" will " +
        "generally be accompanied by a comment on the ticket explaining what is " +
        "needed to improve the code.";
    }
    return "**Accepted · Needs review** — The ticket is waiting for people to " +
      "review the supplied solution. This means downloading the patch and trying " +
      "it out, verifying that it contains tests and docs, running the test suite " +
      "with the included patch, and leaving feedback on the ticket.";
  }
  if (stage === 'Ready for checkin') {
    return "**Ready for checkin** — The ticket was reviewed by a member of the " +
      "community other than the person who supplied the patch and found to meet " +
      "all the requirements for a commit-ready contribution. A merger now needs to " +
      "give a final review. There are a lot of pull requests. It can take a while " +
      "for your patch to get reviewed.";
  }
  if (stage === 'Design decision needed') {
    return "**Design decision needed** — This stage is for issues which may be " +
      "contentious, may be backwards incompatible, or otherwise involve high-level " +
      "design decisions. These issues should be discussed either in the ticket " +
      "comments or on django-developers. Decisions are generally eventually made " +
      "by the core committers.";
  }
  if (stage === 'Someday/Maybe') {
    return "**Someday/Maybe** — Used sparingly to keep track of long-term changes. " +
      "These tickets are uncommon and overall less useful since they don't " +
      "describe concrete actionable issues.";
  }
  return null;
}

module.exports = async ({ github, context, number }) => {
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  number = number ?? context.payload.issue.number;

  const data = await github.graphql(
    `query($owner:String!,$repo:String!,$number:Int!){
       repository(owner:$owner,name:$repo){
         issue(number:$number){
           closedByPullRequestsReferences(first:1,includeClosedPrs:false){totalCount}
           issueFieldValues(first:20){nodes{
             ... on IssueFieldSingleSelectValue{
               field{... on IssueFieldCommon{name}} value }
             ... on IssueFieldMultiSelectValue{
               field{... on IssueFieldCommon{name}} options{name} }
           }}
         }
       }
     }`,
    { owner: repo.owner, repo: repo.repo, number }
  );

  const issueData = data.repository.issue;
  // An OPEN linked pull request is the authoritative "has a patch" signal
  // (replaces the old manual "Has patch" flag). includeClosedPrs:false means a
  // closed/abandoned PR reverts the ticket to "Needs patch".
  const hasPatch = issueData.closedByPullRequestsReferences.totalCount > 0;
  let stage = null;
  const flags = new Set();
  for (const n of issueData.issueFieldValues.nodes) {
    if (!n.field) continue;
    if (n.field.name === 'Triage stage') stage = n.value;
    if (n.field.name === 'Flags') for (const o of n.options) flags.add(o.name);
  }
  if (!stage) return;

  const text = guidanceFor(stage, flags, hasPatch);
  if (!text) return;
  const desired = `${MARKER}\n${text}`;

  const comments = await github.paginate(
    github.rest.issues.listComments,
    { ...repo, issue_number: number, per_page: 100 }
  );
  const existing = comments.find(
    (c) => c.user.type === 'Bot' && c.body && c.body.includes(MARKER)
  );

  if (existing) {
    if (existing.body.trim() !== desired.trim()) {
      await github.rest.issues.updateComment(
        { ...repo, comment_id: existing.id, body: desired });
    }
  } else {
    await github.rest.issues.createComment(
      { ...repo, issue_number: number, body: desired });
  }
};
