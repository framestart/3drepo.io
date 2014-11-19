angular.module('3drepo', [])
.controller('ProjectCtrl', ['$scope', '$http', function($scope, $http){

  $scope.view = "info";

  $scope.setView = function(view){
    $scope.view = view;
  }

  $scope.isView = function(view){
    return $scope.view == view;
  }

}]);