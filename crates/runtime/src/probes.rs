use super::{Clock, WorkerNode};
use std::{collections::HashMap, sync::Arc};
pub const INTERVAL_MS: i64 = 1_800_000;
#[derive(Clone, Debug)]
pub struct ProbeTicket {
    pub id: String,
    pub version: i64,
    pub generation: u64,
    pub node: WorkerNode,
}
struct Target {
    version: i64,
    due: i64,
    inflight: Option<u64>,
    first: bool,
    failures: u32,
}
pub struct ProbePlanner {
    clock: Arc<dyn Clock>,
    targets: HashMap<String, Target>,
    generation: u64,
}
impl ProbePlanner {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            targets: HashMap::new(),
            generation: 0,
        }
    }
    pub fn sync(&mut self, targets: &[(String, i64)]) {
        self.targets
            .retain(|id, _| targets.iter().any(|(current, _)| id == current));
        for (id, version) in targets {
            if self.targets.get(id).is_none_or(|t| t.version != *version) {
                self.targets.insert(
                    id.clone(),
                    Target {
                        version: *version,
                        due: self.clock.millis(),
                        inflight: None,
                        first: true,
                        failures: 0,
                    },
                );
            }
        }
    }
    pub fn seed(&mut self, id: &str, version: i64, checked: i64) {
        self.seed_due(id, version, checked, None);
    }
    pub fn seed_due(&mut self, id: &str, version: i64, checked: i64, due: Option<i64>) {
        if let Some(t) = self.targets.get_mut(id)
            && t.version == version
        {
            t.first = false;
            t.due = due.unwrap_or(checked + INTERVAL_MS);
        }
    }
    pub fn due(
        &mut self,
        nodes: &[WorkerNode],
        maximum: usize,
        excluded: &[String],
    ) -> Vec<ProbeTicket> {
        let Some(node) = nodes.iter().min_by(|a, b| a.uid.cmp(&b.uid)) else {
            return vec![];
        };
        let now = self.clock.millis();
        let mut ids = self
            .targets
            .iter()
            .filter(|(id, t)| t.due <= now && t.inflight.is_none() && !excluded.contains(id))
            .map(|(id, t)| (t.due, id.clone()))
            .collect::<Vec<_>>();
        ids.sort();
        ids.into_iter()
            .take(maximum)
            .map(|(_, id)| {
                self.generation += 1;
                let target = self.targets.get_mut(&id).unwrap();
                target.inflight = Some(self.generation);
                ProbeTicket {
                    id,
                    version: target.version,
                    generation: self.generation,
                    node: node.clone(),
                }
            })
            .collect()
    }
    pub fn current(&self, ticket: &ProbeTicket) -> bool {
        self.targets
            .get(&ticket.id)
            .is_some_and(|t| t.version == ticket.version && t.inflight == Some(ticket.generation))
    }
    pub fn complete(&mut self, ticket: &ProbeTicket, received: bool) -> bool {
        self.complete_at(ticket, received, None)
    }
    pub fn next_due(&self, ticket: &ProbeTicket) -> Option<i64> {
        if !self.current(ticket) {
            return None;
        }
        let now = self.clock.millis();
        let target = &self.targets[&ticket.id];
        let mut due = if target.first {
            now + INTERVAL_MS + phase(&ticket.id)
        } else {
            target.due
        };
        while due <= now {
            due += INTERVAL_MS;
        }
        Some(due)
    }
    pub fn complete_at(
        &mut self,
        ticket: &ProbeTicket,
        received: bool,
        scheduled: Option<i64>,
    ) -> bool {
        if !self.current(ticket) {
            return false;
        }
        let now = self.clock.millis();
        let due = scheduled.or_else(|| self.next_due(ticket)).unwrap();
        let target = self.targets.get_mut(&ticket.id).unwrap();
        target.inflight = None;
        if received {
            target.failures = 0;
            target.due = due;
            target.first = false;
        } else {
            target.failures = target.failures.saturating_add(1);
            target.due =
                now + (5_000i64.saturating_mul(1i64 << target.failures.min(4))).min(60_000);
        }
        true
    }
    pub fn cancel(&mut self, ticket: &ProbeTicket) {
        if self.current(ticket) {
            let target = self.targets.get_mut(&ticket.id).unwrap();
            target.inflight = None;
            target.due = self.clock.millis();
        }
    }
}
fn phase(id: &str) -> i64 {
    (id.bytes().fold(0u64, |hash, byte| {
        hash.wrapping_mul(131).wrapping_add(byte as u64)
    }) % 30_000) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ManualClock;
    fn nodes(n: usize) -> Vec<WorkerNode> {
        (0..n)
            .map(|i| WorkerNode {
                uid: format!("pod-{i}"),
                name: format!("pod-{i}"),
                address: "http://worker".into(),
                slots: 4,
                boot_id: "boot".into(),
            })
            .collect()
    }
    #[test]
    fn a23_one_default_sample_and_per_vpn_cadence_survive_scaling_and_handoff() {
        let clock = Arc::new(ManualClock::new(0));
        let mut planner = ProbePlanner::new(clock.clone());
        let targets = vec![
            ("default_network".into(), 1),
            ("vpn-a".into(), 1),
            ("vpn-b".into(), 1),
        ];
        planner.sync(&targets);
        let first = planner.due(&nodes(3), 4, &[]);
        assert_eq!(first.len(), 3);
        crate::proof::check(
            "A23.probe_cardinality",
            first.len() == 3 && first.iter().filter(|t| t.id == "default_network").count() == 1,
        );
        assert!(planner.due(&nodes(6), 4, &[]).is_empty());
        for t in &first {
            assert!(planner.complete(t, true));
        }
        clock.advance(30_000);
        for count in [3, 6, 6] {
            clock.advance(INTERVAL_MS);
            let round = planner.due(&nodes(count), 4, &[]);
            assert_eq!(round.len(), 3);
            crate::proof::check("A23.scale_to_6", round.len() == 3);
            for t in &round {
                planner.complete(t, true);
            }
        }
        clock.advance(INTERVAL_MS);
        let old = planner.due(&nodes(3), 4, &[]);
        let default = old.iter().find(|t| t.id == "default_network").unwrap();
        planner.cancel(default);
        let replacement = planner.due(&nodes(6)[1..], 4, &[]);
        assert_eq!(replacement.len(), 1);
        assert_ne!(replacement[0].node.uid, default.node.uid);
        crate::proof::check(
            "A23.representative_handoff",
            replacement[0].node.uid != default.node.uid && !planner.current(default),
        );
        assert!(!planner.complete(default, true));
        assert!(planner.complete(&replacement[0], true));
    }
    #[test]
    fn a23_stale_versions_never_publish_and_no_ready_pod_starts_no_probe() {
        let clock = Arc::new(ManualClock::new(0));
        let mut planner = ProbePlanner::new(clock);
        planner.sync(&[("vpn".into(), 1)]);
        assert!(planner.due(&[], 4, &[]).is_empty());
        let old = planner.due(&nodes(1), 4, &[]).remove(0);
        planner.sync(&[("vpn".into(), 2)]);
        crate::proof::check("A23.stale_version", !planner.complete(&old, true));
        let current = planner.due(&nodes(1), 4, &[]).remove(0);
        assert_eq!(current.version, 2);
        assert!(planner.complete(&current, true));
        planner.sync(&[]);
        assert!(planner.due(&nodes(3), 4, &[]).is_empty());
    }
    #[test]
    fn a23_first_sample_near_a_clock_boundary_and_restart_never_trigger_an_extra_round() {
        let clock = Arc::new(ManualClock::new(1_799_999));
        let mut planner = ProbePlanner::new(clock.clone());
        planner.sync(&[("vpn".into(), 1)]);
        let ticket = planner.due(&nodes(1), 4, &[]).remove(0);
        let due = planner.next_due(&ticket).unwrap();
        assert!(due >= clock.millis() + INTERVAL_MS);
        planner.complete_at(&ticket, true, Some(due));
        let mut restarted = ProbePlanner::new(clock.clone());
        restarted.sync(&[("vpn".into(), 1)]);
        restarted.seed_due("vpn", 1, clock.millis(), Some(due));
        clock.advance(INTERVAL_MS - 1);
        assert!(restarted.due(&nodes(1), 4, &[]).is_empty());
        clock.advance(due - clock.millis());
        crate::proof::check(
            "A23.restart_schedule",
            restarted.due(&nodes(1), 4, &[]).len() == 1,
        );
    }
}
