/**
 *  Copyright (C) 2014 3D Repo Ltd
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as
 *  published by the Free Software Foundation, either version 3 of the
 *  License, or (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

angular.module('3drepo')
.config([
'$stateProvider',
'parentStates',
function($stateProvider, parentStates) {
	var states = parentStates["revision"];

	for(var i = 0; i < states.length; i++) {
		$stateProvider
		.state(states[i] + '.branch', {
			url: '/revision/:branch/head',
			resolve: {
				init: function(StateManager, $stateParams) {
					StateManager.setState($stateParams, {});
					StateManager.state.revision = 'head';
					StateManager.refresh('revision');
				}
			}
		})
		.state(states[i] + '.revision', {
			url: '/revision/:revision',
			resolve: {
				init: function(StateManager, $stateParams) {
					StateManager.setState($stateParams, {});
					StateManager.refresh('revision');
				}
			}
		});
	}
}])
.run(['StateManager', function(StateManager) {
	StateManager.registerPlugin('revision', 'RevisionData', function () {
		if (StateManager.state.branch && (StateManager.state.revision == 'head'))
			return "branch";
		else if (StateManager.state.revision)
			return "revision";
		else
			return null;
	});

	StateManager.setClearStateVars("revision", ["revision"]);
	StateManager.setClearStateVars("branch", ["branch"]);
}]);

